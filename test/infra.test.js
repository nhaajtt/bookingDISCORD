import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../src/config.js";
import { getDb, closeDb, transaction } from "../src/db.js";
import { backupDb } from "../src/backup.js";
import { startHeartbeat } from "../src/heartbeat.js";
import { alert } from "../src/alerts.js";
import { startJobs } from "../src/jobs.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withDataDir(fn) {
  const before = config.dataDir;
  config.dataDir = mkdtempSync(path.join(tmpdir(), "booking-test-"));
  closeDb();
  try {
    return fn(config.dataDir);
  } finally {
    closeDb();
    config.dataDir = before;
  }
}

test("the schema is created idempotently and data survives reopening a file database", () => {
  withDataDir((dir) => {
    getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('u1', 'x', 1)").run();
    closeDb();
    const db = getDb();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM blacklist").get().n, 1);
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.ok(existsSync(path.join(dir, "thauxbooking.db")));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
    for (const name of ["attestations", "availability", "blacklist", "bookings", "disputes", "kv", "ledger", "orders", "players", "settings", "strikes", "audit_log", "bank_accounts", "coupons", "wallet_tx", "waitlist", "series"]) assert.ok(tables.includes(name), name);
  });
});

test("the database refuses values outside the allowed statuses", () => {
  closeDb();
  const db = getDb();
  assert.throws(() => db.prepare("INSERT INTO players (user_id, display_name, rate_vnd, status, created_at) VALUES ('x', 'x', 1000, 'WIZARD', 0)").run());
  assert.throws(() => db.prepare("INSERT INTO bookings (customer_id, player_id, game, start_at, duration_min, price_vnd, fee_vnd, status, created_at) VALUES ('a','b','g',0,30,1000,2000,'AWAITING_PAYMENT',0)").run(), "fee above price");
  assert.throws(() => db.prepare("INSERT INTO availability (player_id, weekday, start_min, end_min) VALUES ('a', 7, 0, 60)").run());
  assert.throws(() => db.prepare("INSERT INTO availability (player_id, weekday, start_min, end_min) VALUES ('a', 1, 60, 60)").run());
});

test("transactions commit, roll back, and nest as savepoints", () => {
  closeDb();
  const db = getDb();
  const count = () => db.prepare("SELECT COUNT(*) AS n FROM attestations").get().n;
  const add = (id) => db.prepare("INSERT INTO attestations (user_id, kind, at) VALUES (?, 'k', 0)").run(id);
  transaction(() => (add("a"), add("b")));
  assert.equal(count(), 2);
  assert.throws(() => transaction(() => (add("c"), add("a"))));
  assert.equal(count(), 2, "a failure rolls back the whole transaction");
  transaction(() => {
    add("d");
    assert.throws(() => transaction(() => (add("e"), add("d"))));
    add("f");
  });
  assert.deepEqual(db.prepare("SELECT user_id FROM attestations ORDER BY user_id").all().map((r) => r.user_id), ["a", "b", "d", "f"], "only the inner step was undone");
  assert.equal(transaction(() => transaction(() => 7)), 7);
  assert.throws(() => transaction(() => transaction(() => { throw new Error("deep"); })), /deep/);
  assert.equal(count(), 4);
  transaction(() => add("g"));
  assert.equal(count(), 5, "the connection is usable after a failure");
});

test("backups are written once a day and old ones are pruned", () => {
  withDataDir((dir) => {
    getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('u1', 'x', 1)").run();
    const first = backupDb(new Date("2026-10-05T10:00:00Z"));
    assert.ok(first && existsSync(first));
    assert.equal(backupDb(new Date("2026-10-05T20:00:00Z")), null, "one copy per day");
    for (let day = 6; day <= 14; day += 1) backupDb(new Date(`2026-10-${String(day).padStart(2, "0")}T10:00:00Z`));
    const files = readdirSync(path.join(dir, "backups"));
    assert.equal(files.length, 7);
    assert.ok(!files.includes("thauxbooking-2026-10-05.db"));
    assert.ok(files.includes("thauxbooking-2026-10-14.db"));
  });
});

test("the heartbeat file holds the current time", () => {
  withDataDir((dir) => {
    const timer = startHeartbeat(60_000);
    clearInterval(timer);
    const written = Number(readFileSync(path.join(dir, "heartbeat"), "utf8"));
    assert.ok(Math.abs(Date.now() - written) < 5000);
  });
});

test("alerts do nothing without a webhook, and the same text is sent at most once per five minutes", async () => {
  assert.equal(await alert("x"), false);
  const sent = [];
  config.alertWebhookUrl = "https://hooks.test/abc";
  globalThis.fetch = async (url, init) => (sent.push(JSON.parse(init.body).content), { ok: true });
  try {
    assert.equal(await alert("máy chủ lỗi", 1_000_000), true);
    assert.equal(await alert("máy chủ lỗi", 1_000_000 + 60_000), false);
    assert.equal(await alert("việc khác", 1_000_000 + 60_000), true);
    assert.equal(await alert("máy chủ lỗi", 1_000_000 + 5 * 60_000), true);
    assert.equal(sent.length, 3);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await alert("lại lỗi", 9_000_000), false);
  } finally {
    config.alertWebhookUrl = null;
    globalThis.fetch = undefined;
  }
});

test("the jobs registry starts every file in src/jobs", async () => {
  const names = await startJobs({});
  assert.deepEqual(names, ["backup", "cards", "digest", "leaderboard", "payments", "refunds", "roles", "schedule", "series", "waitlist"]);
});

// ---------------------------------------------------------------- project hygiene

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "data"].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else out.push(full);
  }
  return out;
}

test("every module under src loads", async () => {
  const skip = new Set(["index.js", "deploy-commands.js", "healthcheck.js"]);
  let loaded = 0;
  for (const file of files(path.join(root, "src")).filter((f) => f.endsWith(".js") && !skip.has(path.basename(f)))) {
    await import(pathToFileURL(file).href);
    loaded += 1;
  }
  assert.ok(loaded >= 20, `loaded ${loaded} modules`);
});

test("the entry scripts are valid JavaScript", () => {
  for (const name of ["index.js", "deploy-commands.js", "healthcheck.js"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(root, "src", name)]);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test("no em dashes and none of the forbidden words anywhere in the project", () => {
  const dash = String.fromCharCode(0x2014);
  const banned = [["cla", "ude"], ["anthr", "opic"], ["copi", "lot"], ["chat", "gpt"], ["open", "ai"]].map((p) => p.join(""));
  const textual = /\.(js|json|md|yml|yaml|sh|service|timer|example|gitignore|gitattributes|txt)$|Dockerfile$|\.env\.example$/;
  const bad = [];
  for (const file of files(root)) {
    if (!textual.test(file) && !/\.(gitignore|gitattributes)$/.test(file)) continue;
    if (file.endsWith("package-lock.json")) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(dash)) bad.push(`${path.relative(root, file)}: em dash`);
    for (const word of banned) if (text.toLowerCase().includes(word)) bad.push(`${path.relative(root, file)}: ${word}`);
  }
  assert.deepEqual(bad, []);
});

test("no secrets are committed: no .env file and the example holds only empty keys", () => {
  const example = readFileSync(path.join(root, ".env.example"), "utf8");
  for (const key of ["DISCORD_TOKEN", "PAYOS_API_KEY", "PAYOS_CHECKSUM_KEY", "PAYOS_CLIENT_ID"]) assert.match(example, new RegExp(`^${key}=$`, "m"));
  const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const entry of ["node_modules", ".env", "data/"]) assert.ok(gitignore.split(/\r?\n/).includes(entry), entry);
});

test("the package follows the brief", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "bookingDISCORD");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.engines.node, ">=22.13");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["discord.js", "dotenv"]);
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ["check", "deploy-commands", "license", "restore", "smoke", "start", "test"]);
});

test("the Discord client asks for no privileged intents", () => {
  const index = readFileSync(path.join(root, "src", "index.js"), "utf8");
  assert.match(index, /GatewayIntentBits\.Guilds/);
  assert.match(index, /GatewayIntentBits\.GuildVoiceStates/);
  assert.match(index, /GatewayIntentBits\.GuildMessages/);
  assert.doesNotMatch(index, /MessageContent|GuildMembers|GuildPresences/);
});

test("the domain modules import nothing from Discord", () => {
  for (const file of files(path.join(root, "src", "domain"))) assert.doesNotMatch(readFileSync(file, "utf8"), /from "discord\.js"/, file);
});
