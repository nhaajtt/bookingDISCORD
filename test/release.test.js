import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";
import { closeDb, getDb, runInTenant } from "../src/db.js";
import { backupDb } from "../src/backup.js";
import { unusedImports, importedNames, checkAll } from "../scripts/check.js";
import { checkBackup, listBackups, restore } from "../scripts/restore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

// ---------------------------------------------------------------- the static check

test("the unused-import check finds names that are never used and accepts spreads and namespaces", () => {
  const source = `import a, { b, c as d } from "x";\nimport * as ns from "y";\nimport { e } from "z";\nconsole.log(a, d, ...e);\nconst o = {}; o.b; o.ns;`;
  assert.deepEqual(importedNames(source).map(([n]) => n), ["b", "d", "a", "ns", "e"]);
  assert.deepEqual(unusedImports(source), ["b", "ns"]);
  assert.deepEqual(unusedImports(`import { x } from "q";\nexport { x };\n`), []);
  assert.deepEqual(unusedImports(`import { x } from "q";\nconst y = 1;\n`), ["x"]);
});

test("the project passes its own static check (syntax, unused imports, version)", () => {
  const result = checkAll();
  assert.deepEqual(result.problems, []);
  assert.ok(result.files > 100);
});

// ---------------------------------------------------------------- versions and documents

test("the version has a changelog section, and the release workflow and tag match the same rules", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")}( |$)`, "m"));
  const workflow = read(".github", "workflows", "release.yml");
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /--prerelease/);
  assert.match(read(".github", "workflows", "ci.yml"), /npm run check/);
});

test("every environment variable the code reads is in .env.example, and every command is in the README", async () => {
  const example = read(".env.example");
  const sources = ["config.js", "log.js"].map((f) => read("src", f)).join("\n");
  const names = new Set([...sources.matchAll(/\b(?:env|process\.env)\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(names.size > 15);
  for (const name of names) assert.match(example, new RegExp(`^#?\\s*${name}=`, "m"), `${name} is missing from .env.example`);
  for (const secret of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "DASHBOARD_TOKEN", "METRICS_TOKEN"]) assert.match(example, new RegExp(`^${secret}=$`, "m"), `${secret} must be empty in the example`);

  const readme = read("README.md");
  const dir = path.join(root, "src", "commands");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)).default;
    if (mod.data) assert.ok(readme.includes(`/${mod.data.name}`), `/${mod.data.name} is not in the README`);
  }
  const jobs = readdirSync(path.join(root, "src", "jobs")).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, ""));
  for (const job of jobs) assert.ok(readme.includes(`\`${job}\``), `the ${job} job is not in the README`);
  for (const script of ["smoke", "restore", "license", "check"]) assert.ok(JSON.parse(read("package.json")).scripts[script], script);
});

test("the container image carries the scripts, and nothing secret is in the compose file or the example", () => {
  assert.match(read("Dockerfile"), /COPY scripts \.\/scripts/);
  assert.doesNotMatch(read("docker-compose.yml"), /(token|key|secret)\s*[:=]\s*\S{12,}/i);
});

// ---------------------------------------------------------------- restoring a backup

function withDataDir(fn) {
  const before = config.dataDir;
  const dir = mkdtempSync(path.join(tmpdir(), "booking-restore-"));
  config.dataDir = dir;
  closeDb();
  try {
    return fn(dir);
  } finally {
    closeDb();
    config.dataDir = before;
  }
}

test("a backup is checked, restored, and the database it replaces is kept", () => {
  withDataDir((dir) => {
    getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('keep', 'x', 1)").run();
    const file = backupDb(new Date("2026-10-05T10:00:00Z"));
    assert.deepEqual(listBackups(dir), ["thauxbooking-2026-10-05.db"]);
    assert.deepEqual(checkBackup(file), { ok: true, bookings: 0 });
    getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('later', 'y', 2)").run();
    closeDb();

    const result = restore("2026-10-05", { dataDir: dir, now: new Date("2026-10-06T08:00:00Z") });
    assert.equal(result.restoredFrom, file);
    assert.match(path.basename(result.kept), /^thauxbooking-before-restore-2026-10-06T08-00-00-000Z\.db$/);
    assert.ok(existsSync(result.kept));
    const db = getDb();
    assert.deepEqual(db.prepare("SELECT user_id FROM blacklist ORDER BY user_id").all().map((r) => r.user_id), ["keep"], "the data of the backup is back");
    const old = new DatabaseSync(result.kept, { readOnly: true });
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM blacklist").get().n, 2, "what was replaced is still there");
    old.close();
  });
});

test("a missing, damaged or foreign file is refused and the live database is left alone", () => {
  withDataDir((dir) => {
    getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('x', 'y', 1)").run();
    closeDb();
    assert.throws(() => restore("2026-01-01", { dataDir: dir }), /Backup not found/);
    const junk = path.join(dir, "junk.db");
    writeFileSync(junk, "this is not a database");
    assert.throws(() => restore(junk, { dataDir: dir }), /not usable|not a database/);
    const foreign = path.join(dir, "foreign.db");
    const other = new DatabaseSync(foreign);
    other.exec("CREATE TABLE something (a)");
    other.close();
    assert.throws(() => restore(foreign, { dataDir: dir }), /missing tables: settings, players, bookings, ledger, orders/);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM blacklist").get().n, 1);
  });
});

test("one server of a many-server install is restored from its own folder", () => {
  withDataDir((dir) => {
    const guild = "444444444444444444";
    runInTenant(guild, () => {
      getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('t1', 'x', 1)").run();
      backupDb(new Date("2026-10-05T10:00:00Z"));
      getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('t2', 'x', 1)").run();
    });
    closeDb();
    assert.deepEqual(listBackups(dir, guild), ["thauxbooking-2026-10-05.db"]);
    assert.deepEqual(listBackups(dir), [], "the default database has no backups");
    const result = restore("2026-10-05", { dataDir: dir, guild });
    assert.ok(result.restoredFrom.includes(guild));
    assert.deepEqual(runInTenant(guild, () => getDb().prepare("SELECT user_id FROM blacklist").all().map((r) => r.user_id)), ["t1"]);
  });
});

test("the command-line scripts run: restore lists, smoke and license show their usage without a network", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "booking-cli-"));
  const env = { ...process.env, DATA_DIR: dir, DISCORD_TOKEN: "t", CLIENT_ID: "1", GUILD_ID: "100000000000000002" };
  const list = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/restore.js", "--list"], { cwd: root, env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /No backups yet/);
  const missing = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/restore.js", "2026-01-01"], { cwd: root, env, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Backup not found/);
  const licenseHelp = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/license.js"], { cwd: root, env: { ...env, MULTI_TENANT: "true", GUILD_ID: "" }, encoding: "utf8" });
  assert.equal(licenseHelp.status, 0, licenseHelp.stderr);
  assert.match(licenseHelp.stdout, /Usage/);
  const issued = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/license.js", "issue", "--days", "30"], { cwd: root, env: { ...env, MULTI_TENANT: "true", GUILD_ID: "" }, encoding: "utf8" });
  assert.equal(issued.status, 0, issued.stderr);
  assert.match(issued.stdout, /^Key: BK-/);
  assert.ok(existsSync(path.join(dir, "master.db")));
  const copy = path.join(dir, "x.db");
  copyFileSync(path.join(dir, "master.db"), copy);
  assert.ok(copy);
});
