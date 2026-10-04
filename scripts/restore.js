// Restores a database backup. Stop the bot first.
//   node scripts/restore.js --list              lists the backups in DATA_DIR/backups
//   node scripts/restore.js <file or date>      restores that backup (a date like 2026-10-05 picks thauxbooking-2026-10-05.db)
//   node scripts/restore.js <file or date> --guild <server id>     the same for one server in many-server mode
// The current database is kept next to it as thauxbooking-before-restore-<time>.db, so a restore can itself be undone.
import "dotenv/config";
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const REQUIRED = ["settings", "players", "bookings", "ledger", "orders"];

const paths = (dataDir, guild) => ({
  backups: guild ? path.join(dataDir, "backups", guild) : path.join(dataDir, "backups"),
  live: guild ? path.join(dataDir, "tenants", `${guild}.db`) : path.join(dataDir, "thauxbooking.db"),
  keepIn: guild ? path.join(dataDir, "tenants") : dataDir,
});

export function listBackups(dataDir = process.env.DATA_DIR || "data", guild = null) {
  const { backups } = paths(dataDir, guild);
  return existsSync(backups) ? readdirSync(backups).filter((f) => /^thauxbooking-.*\.db$/.test(f)).sort() : [];
}

export function checkBackup(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const verdict = db.prepare("PRAGMA integrity_check").get();
    if (Object.values(verdict)[0] !== "ok") return { ok: false, reason: "integrity_check failed" };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    const missing = REQUIRED.filter((t) => !tables.includes(t));
    if (missing.length) return { ok: false, reason: `missing tables: ${missing.join(", ")}` };
    const bookings = db.prepare("SELECT COUNT(*) AS n FROM bookings").get().n;
    return { ok: true, bookings };
  } finally {
    db.close();
  }
}

export function restore(arg, { dataDir = process.env.DATA_DIR || "data", guild = null, now = new Date() } = {}) {
  const { backups, live, keepIn } = paths(dataDir, guild);
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? path.join(backups, `thauxbooking-${arg}.db`) : arg;
  if (!existsSync(wanted) || !statSync(wanted).isFile()) throw new Error(`Backup not found: ${wanted}`);
  const check = checkBackup(wanted);
  if (!check.ok) throw new Error(`Backup is not usable: ${check.reason}`);
  let kept = null;
  if (existsSync(live)) {
    kept = path.join(keepIn, `thauxbooking-before-restore-${now.toISOString().replace(/[:.]/g, "-")}.db`);
    copyFileSync(live, kept);
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(`${live}${suffix}`, { force: true });
  copyFileSync(wanted, live);
  return { restoredFrom: wanted, kept, bookings: check.bookings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--guild");
  const guild = at >= 0 ? args.splice(at, 2)[1] : null;
  const arg = args[0];
  if (!arg || arg === "--list") {
    const files = listBackups(undefined, guild);
    console.log(files.length ? files.join("\n") : "No backups yet.");
  } else {
    try {
      const result = restore(arg, { guild });
      console.log(`Restored ${result.restoredFrom} (${result.bookings} bookings).`);
      if (result.kept) console.log(`Previous database kept as ${result.kept}.`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
}
