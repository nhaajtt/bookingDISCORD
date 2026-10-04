import { NOW, HOUR, MIN, makePlayer, makeCustomer, confirmed, ledgerRows, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf } from "./discord-fakes.js";
import voiceEvent from "../src/events/voiceStateUpdate.js";
import { runRoles } from "../src/jobs/roles.js";
import { runSchedule } from "../src/jobs/schedule.js";
import { getBooking } from "../src/domain/bookings.js";
import { getPlayer, markPlayerLeft, setMedia, resumePlayer } from "../src/domain/players.js";
import { listAudit } from "../src/audit.js";
import { log, setLogSink } from "../src/log.js";
import { config } from "../src/config.js";
import { closeDb, getDb as db, runInTenant } from "../src/db.js";
import { refreshCard } from "../src/discord/cards.js";

let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
});

const START = NOW + 26 * HOUR;
const withBooking = (extra = {}) => confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START, ...extra });
const tick = (t) => runSchedule(env.client, { now: t });
const join = (voice, ...ids) => ids.forEach((id) => voice.members.set(id, { id }));

// ---------------------------------------------------------------- the voice fast path

test("a session starts the moment the second person joins the voice room, without waiting for the tick", async () => {
  const b = withBooking();
  await tick(START - 5 * MIN);
  const fresh = getBooking(b.id);
  const voice = env.guild.channels.cache.get(fresh.voice_channel_id);
  join(voice, IDS.cust, IDS.player);
  const { setClock } = await import("../src/discord/clock.js");
  setClock(() => START + 10_000);
  await voiceEvent.execute(env.client, { channelId: null }, { channelId: voice.id, guild: { id: env.guild.id } });
  assert.equal(getBooking(b.id).status, "IN_PROGRESS");
});

test("the voice event ignores other rooms, leaving a room and other servers", async () => {
  const b = withBooking();
  await tick(START - 5 * MIN);
  const voice = env.guild.channels.cache.get(getBooking(b.id).voice_channel_id);
  join(voice, IDS.cust, IDS.player);
  const { setClock } = await import("../src/discord/clock.js");
  setClock(() => START + 10_000);
  await voiceEvent.execute(env.client, { channelId: voice.id }, { channelId: null, guild: { id: env.guild.id } });
  await voiceEvent.execute(env.client, { channelId: null }, { channelId: "999", guild: { id: env.guild.id } });
  await voiceEvent.execute(env.client, { channelId: null }, { channelId: voice.id, guild: { id: "424242424242424242" } });
  assert.equal(getBooking(b.id).status, "CONFIRMED");
});

test("two scheduler runs never overlap: the one that finds the other busy leaves the work to it", async () => {
  withBooking();
  const first = tick(START - 5 * MIN);
  const second = await tick(START - 5 * MIN);
  assert.equal(second.busy, true);
  await first;
  assert.notEqual((await tick(START - 4 * MIN)).busy, true);
});

// ---------------------------------------------------------------- players who leave the server

test("a player who left the server is paused, their upcoming bookings are refunded and the owner is told; coming back clears the mark", async () => {
  const b = withBooking();
  env.guild.members.cache.delete(IDS.player);
  const result = await runRoles(env.client);
  assert.ok(result);
  const player = getPlayer(IDS.player);
  assert.equal(player.status, "PAUSED");
  assert.ok(player.leftAt);
  assert.equal(getBooking(b.id).status, "CANCELLED");
  assert.equal(ledgerRows(b.id).find((r) => r.kind === "REFUND").amount_vnd, b.price_vnd);
  assert.ok(dms(env.client, IDS.cust).some((t) => /Lịch #1 .* đã bị huỷ/.test(t)));
  const log_ = env.guild.channelNamed("nhật-ký").sent.map((m) => m.content).join("\n");
  assert.match(log_, /đã rời server nên bị chuyển sang nghỉ.*Đã huỷ 1 lịch/);

  await runRoles(env.client);
  assert.equal(env.guild.channelNamed("nhật-ký").sent.filter((m) => /nên bị chuyển sang nghỉ/.test(m.content)).length, 1, "told once");

  env.guild.addMember({ id: IDS.player });
  await runRoles(env.client);
  assert.equal(getPlayer(IDS.player).leftAt, null);
  assert.equal(getPlayer(IDS.player).status, "PAUSED", "they resume on their own");
  assert.ok(dms(env.client, IDS.player).some((t) => /quay lại/.test(t)));
  assert.equal(resumePlayer(IDS.player).status, "ACTIVE");
});

test("rooms that cannot be created because the player is gone pause them instead of failing for ever", async () => {
  const b = withBooking();
  env.guild.members.cache.delete(IDS.player);
  const original = env.guild.channels.create;
  env.guild.channels.create = async () => {
    throw Object.assign(new Error("Unknown User"), { code: 10013 });
  };
  const result = await tick(START - 5 * MIN);
  env.guild.channels.create = original;
  assert.equal(result.failed, 0);
  assert.equal(getBooking(b.id).status, "CANCELLED");
  assert.equal(getPlayer(IDS.player).status, "PAUSED");
});

test("a transient failure to find a member does not pause anybody", async () => {
  withBooking();
  const original = env.guild.members.fetch;
  env.guild.members.fetch = async () => {
    throw Object.assign(new Error("Discord is down"), { code: 500 });
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    await runRoles(env.client);
  } finally {
    console.error = originalError;
    env.guild.members.fetch = original;
  }
  assert.equal(getPlayer(IDS.player).status, "ACTIVE");
  assert.equal(getPlayer(IDS.player).leftAt, null);
});

test("markPlayerLeft keeps a suspended player suspended and records the time once", () => {
  getDb().prepare("UPDATE players SET status = 'SUSPENDED' WHERE user_id = ?").run(IDS.player);
  assert.equal(markPlayerLeft(IDS.player, 5), true);
  assert.equal(getPlayer(IDS.player).status, "SUSPENDED");
  assert.equal(markPlayerLeft(IDS.player, 9), false);
  assert.equal(getPlayer(IDS.player).leftAt, 5);
});

// ---------------------------------------------------------------- player media links

test("profile media accepts https links only, at most three photos, and empty clears", () => {
  const p = setMedia(IDS.player, { photos: ["https://i.example/a.png", "https://i.example/b.png", "https://i.example/c.png", "https://i.example/d.png"], voiceUrl: "https://example.com/voice.mp3" });
  assert.equal(p.photos.length, 3);
  assert.equal(p.voiceUrl, "https://example.com/voice.mp3");
  assert.throws(() => setMedia(IDS.player, { photos: ["http://insecure.example/a.png"] }), /https/);
  assert.throws(() => setMedia(IDS.player, { photos: ["not a link"] }), /đường dẫn hợp lệ/);
  assert.throws(() => setMedia(IDS.player, { voiceUrl: "https://discord.gg/abc" }), /link mời/);
  const cleared = setMedia(IDS.player, { photos: [], voiceUrl: "" });
  assert.deepEqual(cleared.photos, []);
  assert.equal(cleared.voiceUrl, "");
});

// ---------------------------------------------------------------- the audit trail

test("staff and owner commands and buttons are recorded, ordinary ones are not", async () => {
  await env.command(IDS.owner, "admin", { subcommand: "donhang" });
  await env.command(IDS.cust, "lichcuatoi");
  await env.click(IDS.rando, "mn:paid:999");
  const rows = listAudit({ limit: 50 }).map((r) => `${r.actor_id}|${r.action}`);
  assert.ok(rows.includes(`${IDS.owner}|/admin donhang`));
  assert.ok(rows.includes(`${IDS.rando}|mn:paid:999`), "a refused attempt is on record too");
  assert.ok(!rows.some((r) => r.includes("lichcuatoi")));
  assert.ok(rows.some((r) => r.includes("/setup")), "the setup done in boot is on record");
  assert.deepEqual(listAudit({ actorId: IDS.cust }), []);
});

// ---------------------------------------------------------------- the log

test("log lines are structured, respect the level and carry the error message without a stack", () => {
  const seen = [];
  setLogSink((r) => seen.push(r));
  try {
    log.info("hello", { booking: 3 });
    log.debug("quiet");
    log.error("boom", { error: Object.assign(new Error("bad thing"), { code: 42 }), user: "u" });
  } finally {
    setLogSink(null);
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0].event, "hello");
  assert.equal(seen[0].booking, 3);
  assert.equal(seen[1].error, "bad thing");
  assert.equal(seen[1].code, 42);
  assert.equal(seen[1].stack, undefined);
});

// ---------------------------------------------------------------- databases

test("an old database file without the newer columns and tables is upgraded in place when opened", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "booking-migrate-"));
  const file = path.join(dir, "thauxbooking.db");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, player_id TEXT NOT NULL, game TEXT NOT NULL, start_at INTEGER NOT NULL, duration_min INTEGER NOT NULL, price_vnd INTEGER NOT NULL, fee_vnd INTEGER NOT NULL, status TEXT NOT NULL, order_code INTEGER, text_channel_id TEXT, voice_channel_id TEXT, created_at INTEGER NOT NULL, paid_at INTEGER, started_at INTEGER, ended_at INTEGER, rating INTEGER, review TEXT, cancelled_by TEXT, refund_due_vnd INTEGER NOT NULL DEFAULT 0, reminders_sent TEXT NOT NULL DEFAULT '{}')");
  old.exec("CREATE TABLE orders (order_code INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL, user_id TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, checkout_url TEXT, created_at INTEGER NOT NULL, paid_at INTEGER)");
  old.exec("CREATE TABLE players (user_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, games TEXT NOT NULL DEFAULT '[]', rate_vnd INTEGER NOT NULL, bio TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, rating_sum INTEGER NOT NULL DEFAULT 0, rating_count INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, approved_at INTEGER, profile_message_id TEXT)");
  old.exec("INSERT INTO bookings (customer_id, player_id, game, start_at, duration_min, price_vnd, fee_vnd, status, created_at) VALUES ('c','p','g',1,60,100000,10000,'CONFIRMED',1)");
  old.close();
  const before = config.dataDir;
  config.dataDir = dir;
  closeDb();
  try {
    const handle = db();
    const cols = (t) => handle.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ["list_price_vnd", "discount_vnd", "coupon_code", "series_id", "extended_min", "paid_with"]) assert.ok(cols("bookings").includes(c), c);
    for (const c of ["kind", "provider", "external_id", "extra_min"]) assert.ok(cols("orders").includes(c), c);
    for (const c of ["photos", "voice_url", "left_at"]) assert.ok(cols("players").includes(c), c);
    assert.equal(handle.prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 1, "the data stays");
    assert.equal(handle.prepare("SELECT discount_vnd FROM bookings").get().discount_vnd, 0);
    closeDb();
    assert.ok(db(), "opening again changes nothing and does not fail");
  } finally {
    closeDb();
    config.dataDir = before;
  }
});

test("each tenant has its own database, and the default one is untouched", () => {
  getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('only-default', 'x', 1)").run();
  runInTenant("424242424242424242", () => {
    assert.equal(db().prepare("SELECT COUNT(*) AS n FROM blacklist").get().n, 0);
    db().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('only-tenant', 'x', 1)").run();
  });
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM blacklist").get().n, 1);
  assert.equal(getDb().prepare("SELECT user_id FROM blacklist").get().user_id, "only-default");
  runInTenant("424242424242424242", () => assert.equal(db().prepare("SELECT user_id FROM blacklist").get().user_id, "only-tenant"));
});
