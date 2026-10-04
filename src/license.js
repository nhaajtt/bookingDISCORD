import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

// Licenses for multi-server mode (MULTI_TENANT=true). They live in one small database of their own, data/master.db, next to the
// per-server databases. The operator of the bot issues a key (npm run license -- issue ...); the owner of a Discord server activates it
// there with /kichhoat, which ties the key to that server. A license has a plan name and an end date, and after the end date there is a
// short grace period in which the server keeps working but is warned.
//
// A single-server install (the default) never reads any of this.

export const GRACE_DAYS = 3;
const DAY = 86_400_000;

let master = null;

const schema = `
CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY,
  guild_id TEXT,
  plan TEXT NOT NULL DEFAULT 'standard',
  days INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS licenses_guild ON licenses (guild_id);
`;

function open() {
  if (master) return master;
  let file = ":memory:";
  if (config.dataDir !== ":memory:") {
    mkdirSync(config.dataDir, { recursive: true });
    file = path.join(config.dataDir, "master.db");
  }
  master = new DatabaseSync(file);
  master.exec("PRAGMA journal_mode = WAL;");
  master.exec(schema);
  return master;
}

export function closeMaster() {
  master?.close();
  master = null;
  cache.clear();
}

const cache = new Map();
const CACHE_MS = 30_000;

const row = (r) => r && { key: r.key, guildId: r.guild_id, plan: r.plan, days: r.days, issuedAt: r.issued_at, activatedAt: r.activated_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, note: r.note };

// issueLicense({ days, plan?, guildId?, note? }, now) -> license. A key tied to a server starts at once; otherwise it starts when it is activated.
export function issueLicense({ days, plan = "standard", guildId = null, note = "" }, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error("days must be between 1 and 3660");
  if (guildId !== null && !/^\d{17,20}$/.test(String(guildId))) throw new Error("guildId must be a Discord server id");
  const key = `BK-${randomBytes(3).toString("hex").toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}-${randomBytes(3).toString("hex").toUpperCase()}`;
  open()
    .prepare("INSERT INTO licenses (key, guild_id, plan, days, issued_at, activated_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(key, guildId, String(plan).slice(0, 30), days, now, guildId ? now : null, guildId ? now + days * DAY : null, String(note).slice(0, 100) || null);
  cache.clear();
  return getLicense(key);
}

export const getLicense = (key) => row(open().prepare("SELECT * FROM licenses WHERE key = ?").get(String(key ?? "").trim().toUpperCase()));
export const listLicenses = () => open().prepare("SELECT * FROM licenses ORDER BY issued_at DESC").all().map(row);

// activateLicense(key, guildId, now) -> license. Ties an unused key to a server. A server that already has a running license may add
// another key: its days are added after the current end.
export function activateLicense(key, guildId, now = Date.now()) {
  const db = open();
  const lic = getLicense(key);
  if (!lic || lic.revokedAt) return { ok: false, reason: "Mã kích hoạt không đúng hoặc đã bị thu hồi." };
  if (lic.guildId) return { ok: false, reason: lic.guildId === guildId ? "Mã này đã được kích hoạt cho server này rồi." : "Mã này đã được dùng cho một server khác." };
  const current = db.prepare("SELECT MAX(expires_at) AS at FROM licenses WHERE guild_id = ? AND revoked_at IS NULL").get(guildId)?.at ?? 0;
  const startsAt = Math.max(now, current);
  db.prepare("UPDATE licenses SET guild_id = ?, activated_at = ?, expires_at = ? WHERE key = ? AND guild_id IS NULL").run(guildId, now, startsAt + lic.days * DAY, lic.key);
  cache.clear();
  return { ok: true, license: getLicense(lic.key) };
}

export function revokeLicense(key, now = Date.now()) {
  const changed = Number(open().prepare("UPDATE licenses SET revoked_at = ? WHERE key = ? AND revoked_at IS NULL").run(now, String(key).trim().toUpperCase()).changes);
  cache.clear();
  return changed > 0;
}

// licenseStatus(guildId, now) -> { ok, state: "active" | "grace" | "expired" | "none", plan, expiresAt, daysLeft, reason? }
export function licenseStatus(guildId, now = Date.now()) {
  const hit = cache.get(guildId);
  if (hit && now - hit.at < CACHE_MS && hit.now <= now) return hit.value;
  const r = open().prepare("SELECT * FROM licenses WHERE guild_id = ? AND revoked_at IS NULL ORDER BY expires_at DESC LIMIT 1").get(guildId);
  let value;
  if (!r) value = { ok: false, state: "none", plan: null, expiresAt: null, daysLeft: 0, reason: "Server này chưa kích hoạt. Chủ server dùng /kichhoat với mã đã mua." };
  else if (now < r.expires_at) value = { ok: true, state: "active", plan: r.plan, expiresAt: r.expires_at, daysLeft: Math.ceil((r.expires_at - now) / DAY) };
  else if (now < r.expires_at + GRACE_DAYS * DAY) value = { ok: true, state: "grace", plan: r.plan, expiresAt: r.expires_at, daysLeft: 0, reason: "Giấy phép đã hết hạn, đang trong thời gian ân hạn. Hãy gia hạn bằng /kichhoat." };
  else value = { ok: false, state: "expired", plan: r.plan, expiresAt: r.expires_at, daysLeft: 0, reason: "Giấy phép của server đã hết hạn. Chủ server dùng /kichhoat với mã mới để tiếp tục." };
  if (cache.size > 1000) cache.clear();
  cache.set(guildId, { at: now, now, value });
  return value;
}

// The servers that may be served right now (active or in grace)
export function licensedGuildIds(now = Date.now()) {
  return open()
    .prepare("SELECT DISTINCT guild_id FROM licenses WHERE guild_id IS NOT NULL AND revoked_at IS NULL AND expires_at + ? > ?")
    .all(GRACE_DAYS * DAY, now)
    .map((r) => r.guild_id);
}
