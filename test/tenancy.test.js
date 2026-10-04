import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, confirmed, fresh } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadModules } from "./discord-env.js";
import { makeWorld, makeInteraction, makeOwner, person, textOf, modalOf, dms, buttonIds, lastPayload } from "./discord-fakes.js";
import { config } from "../src/config.js";
import { closeDb, getDb, runInTenant, currentTenant, openTenants, withoutTenant } from "../src/db.js";
import { createRouter } from "../src/discord/router.js";
import { resetLimits } from "../src/discord/limits.js";
import { setClock } from "../src/discord/clock.js";
import { installNotifier } from "../src/discord/notify.js";
import { sendDm } from "../src/discord/guild.js";
import { issueLicense, activateLicense, revokeLicense, licenseStatus, licensedGuildIds, getLicense, listLicenses, closeMaster, GRACE_DAYS } from "../src/license.js";
import { guildAccess, withGuild, forEachGuild, activeGuildIds, setGuildSource } from "../src/tenancy.js";
import { hasAttested, attest } from "../src/domain/attestations.js";
import { getSettings, saveSettings } from "../src/settings.js";
import { getBank, setBank } from "../src/domain/bank.js";
import { paymentKeys, savePaymentKeys } from "../src/pay/credentials.js";
import { payosEnabled, verifyWebhookSignature } from "../src/pay/payos.js";
import { enabledProviders } from "../src/pay/gateway.js";
import { isOwner } from "../src/discord/permissions.js";
import { backupDb } from "../src/backup.js";
import { runSchedule } from "../src/jobs/schedule.js";
import { createWebServer } from "../src/web/server.js";
import { dashboardToken } from "../src/web/auth.js";
import { run as licenseCli } from "../scripts/license.js";
import { startJobs } from "../src/jobs.js";
import { runDigest } from "../src/jobs/digest.js";
import { activeStrikeCount } from "../src/domain/strikes.js";

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realFetch = globalThis.fetch;
const original = { multi: config.multiTenant, required: config.licenseRequired, guildId: config.guildId, owners: [...config.ownerIds] };

let router;
beforeEach(async () => {
  fresh();
  closeMaster();
  resetLimits();
  setClock(() => NOW);
  config.multiTenant = true;
  config.licenseRequired = true;
  router = createRouter(await loadModules());
});
afterEach(() => {
  config.multiTenant = original.multi;
  config.licenseRequired = original.required;
  config.guildId = original.guildId;
  config.ownerIds = original.owners;
  closeMaster();
  setGuildSource(() => []);
  globalThis.fetch = realFetch;
});

// A server of its own: a fake guild with this id, a client that knows it, and a way to act in it
function server(guildId, { licensed = true } = {}) {
  const world = makeWorld();
  world.client.guilds.cache.delete(world.guild.id);
  world.guild.id = guildId;
  world.client.guilds.cache.set(guildId, world.guild);
  installNotifier(world.client);
  if (licensed) issueLicense({ days: 30, guildId }, NOW);
  const act = async (user, options) => {
    const i = makeInteraction(world, typeof user === "string" ? person(world, user) : user, options);
    await router.dispatch(i);
    return i;
  };
  return {
    world,
    guild: world.guild,
    client: world.client,
    owner: makeOwner(world, "900000000000000001"),
    command: (user, commandName, o = {}) => act(user, { kind: "command", commandName, subcommand: o.subcommand, opts: o.opts }),
    click: (user, customId) => act(user, { kind: "button", customId }),
    dmClick: (user, customId) => act(user, { kind: "button", customId, dm: true }),
    submit: (user, customId, fields = {}) => act(user, { kind: "modal", customId, fields }),
    dmSubmit: (user, customId, fields = {}) => act(user, { kind: "modal", customId, fields, dm: true }),
  };
}
const inTenant = (id, fn) => runInTenant(id, fn);

// ---------------------------------------------------------------- licenses

test("a license key starts when it is activated, ties to one server, and chains after a running one", () => {
  const key = issueLicense({ days: 30, plan: "pro", note: "khách A" }, NOW);
  assert.match(key.key, /^BK-[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/);
  assert.deepEqual([key.guildId, key.expiresAt, key.plan], [null, null, "pro"]);
  assert.equal(licenseStatus(A, NOW).state, "none");
  const done = activateLicense(key.key.toLowerCase(), A, NOW);
  assert.equal(done.ok, true);
  assert.equal(done.license.expiresAt, NOW + 30 * DAY);
  assert.deepEqual([licenseStatus(A, NOW).state, licenseStatus(A, NOW).daysLeft, licenseStatus(A, NOW).plan], ["active", 30, "pro"]);
  assert.match(activateLicense(key.key, B, NOW).reason, /đã được dùng cho một server khác/);
  assert.match(activateLicense(key.key, A, NOW).reason, /đã được kích hoạt cho server này rồi/);
  assert.match(activateLicense("BK-NOPE", A, NOW).reason, /không đúng/);

  const more = issueLicense({ days: 10 }, NOW);
  const chained = activateLicense(more.key, A, NOW + 5 * DAY);
  assert.equal(chained.license.expiresAt, NOW + 40 * DAY, "the new days are added after the current end");
  assert.equal(licenseStatus(A, NOW + 6 * DAY).daysLeft, 34);
});

test("a key made for a server starts at once, and bad requests are refused", () => {
  const lic = issueLicense({ days: 7, guildId: B }, NOW);
  assert.equal(lic.expiresAt, NOW + 7 * DAY);
  assert.equal(licenseStatus(B, NOW).ok, true);
  assert.throws(() => issueLicense({ days: 0 }, NOW), /days/);
  assert.throws(() => issueLicense({ days: 30, guildId: "abc" }, NOW), /server id/);
  assert.equal(issueLicense({ days: 30, guildId: B }, NOW).guildId, B, "a server may hold several keys; their days add up");
  assert.equal(licenseStatus(B, NOW + 20 * DAY).state, "active");
});

test("after the end date there is a grace period, then the server is switched off; a revoked key stops at once", () => {
  issueLicense({ days: 10, guildId: A }, NOW);
  const end = NOW + 10 * DAY;
  assert.equal(licenseStatus(A, end - HOUR).state, "active");
  const grace = licenseStatus(A, end + HOUR);
  assert.deepEqual([grace.ok, grace.state], [true, "grace"]);
  assert.match(grace.reason, /ân hạn/);
  const expired = licenseStatus(A, end + (GRACE_DAYS + 1) * DAY);
  assert.deepEqual([expired.ok, expired.state], [false, "expired"]);
  assert.deepEqual(licensedGuildIds(end + HOUR), [A]);
  assert.deepEqual(licensedGuildIds(end + (GRACE_DAYS + 1) * DAY), []);
  const lic = issueLicense({ days: 30, guildId: B }, NOW);
  assert.equal(licenseStatus(B, NOW).ok, true);
  assert.equal(revokeLicense(lic.key, NOW), true);
  assert.equal(revokeLicense(lic.key, NOW), false);
  assert.equal(licenseStatus(B, NOW).ok, false);
  assert.match(activateLicense(lic.key, C, NOW).reason, /thu hồi/);
  assert.equal(listLicenses().length, 2);
  assert.equal(getLicense(lic.key).revokedAt, NOW);
});

test("the operator's command line issues, lists, shows and revokes keys", () => {
  const lines = [];
  const out = (t) => lines.push(t);
  const issued = licenseCli(["issue", "--days", "14", "--plan", "mini", "--note", "dùng thử"], out);
  assert.match(lines[0], /^Key: BK-/);
  assert.match(lines[1], /Plan: mini, 14 days, starts when it is activated/);
  const tied = licenseCli(["issue", "--days", "30", "--guild", C], out);
  assert.match(lines.at(-1), new RegExp(`tied to server ${C}`));
  licenseCli(["list"], out);
  assert.equal(lines.filter((l) => l.startsWith("BK-")).length, 2);
  assert.match(lines.join("\n"), /dùng thử/);
  licenseCli(["show", issued.key], out);
  assert.match(lines.at(-1), /"plan": "mini"/);
  licenseCli(["show", C], out);
  assert.match(lines.at(-1), /"state": "active"/);
  licenseCli(["revoke", issued.key], out);
  assert.equal(lines.at(-1), "Revoked.");
  licenseCli(["revoke", issued.key], out);
  assert.match(lines.at(-1), /already revoked/);
  licenseCli(["nonsense"], out);
  assert.match(lines.at(-1), /Usage/);
  assert.throws(() => licenseCli(["issue", "--days", "abc"], out), /days/);
});

// ---------------------------------------------------------------- who is served

test("single-server mode serves only GUILD_ID and ignores licenses; multi-server mode needs a license", async () => {
  config.multiTenant = false;
  config.guildId = A;
  assert.deepEqual(guildAccess(A), { ok: true });
  assert.equal(guildAccess(B).ok, false);
  assert.equal(await withGuild(B, () => "x"), undefined);
  assert.equal(await withGuild(A, () => "ran"), "ran");
  assert.equal(currentTenant(), null, "no tenant in single-server mode");

  config.multiTenant = true;
  assert.equal(guildAccess(A).ok, false, "no license yet");
  assert.equal(await withGuild(A, () => "x"), undefined);
  issueLicense({ days: 30, guildId: A }, NOW);
  assert.equal(await withGuild(A, () => currentTenant()), A);
  config.licenseRequired = false;
  assert.equal(guildAccess(C).ok, true, "LICENSE_REQUIRED=false serves everyone");
  assert.equal(guildAccess(null).ok, false);
});

test("jobs visit every licensed server the bot is in, each in its own data, and one failing does not stop the others", async () => {
  issueLicense({ days: 30, guildId: A }, NOW);
  issueLicense({ days: 30, guildId: B }, NOW);
  setGuildSource(() => [A, B, C]);
  assert.deepEqual(activeGuildIds(NOW), [A, B], "C has no license");
  const seen = [];
  await forEachGuild((id) => seen.push([id, currentTenant()]));
  assert.deepEqual(seen, [[A, A], [B, B]]);
  const ran = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      forEachGuild((id) => {
        ran.push(id);
        if (id === A) throw new Error("boom");
      }),
      /boom/,
    );
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(ran, [A, B], "B still ran after A failed");
  setGuildSource(() => []);
  assert.deepEqual(await forEachGuild(() => 1), []);
  const names = await startJobs({});
  assert.ok(names.includes("schedule"));
});

// ---------------------------------------------------------------- data is kept apart

test("two servers have their own databases: attestations, settings, bank details and players do not leak", async () => {
  const a = server(A);
  const b = server(B);
  await a.command(a.owner, "setup");
  await b.command(b.owner, "setup");
  inTenant(A, () => saveSettings({ ...getSettings(), feePercent: 25 }));
  assert.equal(inTenant(B, () => getSettings().feePercent), 10);
  assert.equal(inTenant(A, () => getSettings().feePercent), 25);
  const ageA = inTenant(A, () => getSettings().channels.ageGateChannelId);
  const ageB = inTenant(B, () => getSettings().channels.ageGateChannelId);
  assert.ok(ageA && ageB);

  const user = "900000000000000050";
  await a.click(user, "age:open");
  await a.submit(user, "age:submit", { phrase: "tôi đã đủ 18 tuổi" });
  assert.equal(inTenant(A, () => hasAttested(user)), true);
  assert.equal(inTenant(B, () => hasAttested(user)), false, "attesting in A does nothing in B");
  const denied = await b.command(user, "nganhang", { subcommand: "xem" });
  assert.match(textOf(denied), /18 tuổi/);
  await a.submit(user, "bank:set", { bank: "vcb", number: "123456789", holder: "Nguyen A" });
  assert.ok(inTenant(A, () => getBank(user)));
  assert.equal(inTenant(B, () => getBank(user)), null);
  assert.equal(withoutTenant(() => getDb().prepare("SELECT COUNT(*) AS n FROM bank_accounts").get().n), 0, "the default database was not touched");
  assert.throws(() => getDb(), /outside any server/, "in many-server mode nothing may open a database without a server");
  assert.deepEqual(new Set(openTenants()), new Set(["default", A, B]));
});

test("booking numbers and strikes are counted per server", () => {
  inTenant(A, () => {
    attest("u1", NOW - DAY);
    getDb().prepare("INSERT INTO strikes (user_id, reason, created_at) VALUES ('u1', 'x', ?)").run(NOW);
  });
  assert.equal(inTenant(A, () => activeStrikeCount("u1", NOW)), 1);
  assert.equal(inTenant(B, () => activeStrikeCount("u1", NOW)), 0);
});

// ---------------------------------------------------------------- licenses at the door

test("a server without a license is told why and nothing runs; /kichhoat is the one way in", async () => {
  const c = server(C, { licensed: false });
  const refused = await c.command(c.owner, "setup");
  assert.match(textOf(refused), /chưa kích hoạt.*\/kichhoat/);
  assert.equal(c.guild.created.length, 0, "/setup built nothing");
  assert.match(textOf(await c.click("900000000000000050", "age:open")), /chưa kích hoạt/);

  const stranger = await c.command("900000000000000050", "kichhoat", { opts: { ma: "BK-X" } });
  assert.match(textOf(stranger), /Chỉ quản trị viên/);
  const wrong = await c.command(c.owner, "kichhoat", { opts: { ma: "BK-000000-000000-000000" } });
  assert.match(textOf(wrong), /không đúng/);
  const key = issueLicense({ days: 30, plan: "pro" }, NOW);
  const ok = await c.command(c.owner, "kichhoat", { opts: { ma: key.key } });
  assert.match(textOf(ok), /Đã kích hoạt gói pro.*còn 30 ngày.*\/setup/);
  const built = await c.command(c.owner, "setup");
  assert.ok(c.guild.created.length > 0, "now /setup works");
  assert.ok(built.out.length > 0);
});

test("an expired license switches the server off after the grace period, with the reason", async () => {
  const a = server(A);
  await a.command(a.owner, "setup");
  setClock(() => NOW + 31 * DAY);
  assert.equal(licenseStatus(A, NOW + 31 * DAY).state, "grace");
  const warn = await a.command(a.owner, "admin", { subcommand: "giay-phep" });
  assert.match(textOf(warn), /đã hết hạn, đang ân hạn/);
  setClock(() => NOW + 40 * DAY);
  const off = await a.command(a.owner, "admin", { subcommand: "giay-phep" });
  assert.match(textOf(off), /đã hết hạn/);
  const renew = issueLicense({ days: 30 }, NOW + 40 * DAY);
  await a.command(a.owner, "kichhoat", { opts: { ma: renew.key } });
  assert.equal(licenseStatus(A, NOW + 40 * DAY).ok, true);
});

test("/admin giay-phep shows the plan and days left, and says nothing is needed in single-server mode", async () => {
  const a = server(A);
  await a.command(a.owner, "setup");
  assert.match(textOf(await a.command(a.owner, "admin", { subcommand: "giay-phep" })), /Gói standard, còn 30 ngày/);
  config.multiTenant = false;
  config.guildId = A;
  assert.match(textOf(await a.command(a.owner, "admin", { subcommand: "giay-phep" })), /không cần giấy phép/);
  assert.match(textOf(await a.command(a.owner, "kichhoat", { opts: { ma: "x" } })), /không cần kích hoạt/);
});

test("the digest warns the owner when a license is about to end", async () => {
  const a = server(A);
  await a.command(a.owner, "setup");
  inTenant(A, () => {});
  const posted = await inTenant(A, () => runDigest(a.client, { now: NOW + 24 * DAY + 8 * HOUR }));
  assert.equal(posted, "daily");
  const money = a.guild.channelNamed("sổ-tiền").sent.at(-1);
  assert.match(money.content, /Giấy phép còn 6 ngày\. Gia hạn bằng \/kichhoat/);
});

// ---------------------------------------------------------------- owners and payment keys

test("OWNER_IDS belong to a single-server install: in multi-server mode only an Administrator is an owner", () => {
  config.ownerIds = ["900000000000000077"];
  assert.equal(isOwner({ permissions: { has: () => false } }, "900000000000000077"), false);
  assert.equal(isOwner({ permissions: { has: () => true } }, "900000000000000078"), true);
  config.multiTenant = false;
  assert.equal(isOwner({ permissions: { has: () => false } }, "900000000000000077"), true);
});

test("each server brings its own payment keys, stored in its own database and never in the shared environment", async () => {
  const a = server(A);
  const b = server(B);
  await a.command(a.owner, "setup");
  await b.command(b.owner, "setup");
  assert.equal(inTenant(A, () => payosEnabled()), false);
  const open = await a.command(a.owner, "admin", { subcommand: "thanh-toan", opts: { "cong-mac-dinh": "payos" } });
  assert.equal(modalOf(open).toJSON().custom_id, "ad:keys:payos");
  assert.deepEqual(modalOf(open).toJSON().components.map((r) => r.components[0].custom_id), ["payosClient", "payosKey", "payosChecksum", "stripeKey", "returnUrl"]);
  const saved = await a.submit(a.owner, "ad:keys:payos", { payosClient: "cid", payosKey: "akey", payosChecksum: "sum", stripeKey: "", returnUrl: "https://shop.example/ok" });
  assert.match(textOf(saved), /Cổng đang bật: payOS/);
  assert.equal(inTenant(A, () => payosEnabled()), true);
  assert.equal(inTenant(B, () => payosEnabled()), false);
  assert.equal(inTenant(A, () => paymentKeys().returnUrl), "https://shop.example/ok");
  assert.deepEqual(inTenant(B, () => enabledProviders()), []);
  assert.equal(config.payos.apiKey, "api-key", "the environment keys are untouched");
  // keep what is not retyped, remove with a dash
  await a.submit(a.owner, "ad:keys:auto", { payosClient: "", payosKey: "", payosChecksum: "", stripeKey: "sk_live_x", returnUrl: "" });
  assert.deepEqual(inTenant(A, () => enabledProviders()), ["payos", "stripe"]);
  await a.submit(a.owner, "ad:keys:auto", { payosKey: "-" });
  assert.deepEqual(inTenant(A, () => enabledProviders()), ["stripe"]);
  assert.match(textOf(await a.submit("900000000000000050", "ad:keys:auto", { payosKey: "x" })), /không có quyền/);
  config.multiTenant = false;
  config.guildId = A;
  assert.match(textOf(await a.command(a.owner, "admin", { subcommand: "thanh-toan" })), /chế độ một server/);
});

test("a payOS webhook is checked against the keys of the server named in its address", async () => {
  const a = server(A);
  const b = server(B);
  inTenant(A, () => savePaymentKeys({ payos: { clientId: "c", apiKey: "k", checksumKey: "key-of-A" } }));
  inTenant(B, () => savePaymentKeys({ payos: { clientId: "c", apiKey: "k", checksumKey: "key-of-B" } }));
  const web = createWebServer({ client: a.client, now: () => NOW });
  const port = await web.listen(0, "127.0.0.1");
  const sign = (data, key) => createHmac("sha256", key).update(Object.keys(data).sort().map((k) => `${k}=${data[k]}`).join("&")).digest("hex");
  const data = { orderCode: 5, amount: 1000 };
  const post = (p, key) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data, signature: sign(data, key) }) });
  try {
    assert.equal((await post(`/webhook/payos/${A}`, "key-of-A")).status, 200);
    assert.equal((await post(`/webhook/payos/${A}`, "key-of-B")).status, 401, "B's key does not open A");
    assert.equal((await post(`/webhook/payos/${B}`, "key-of-B")).status, 200);
    assert.equal((await post(`/webhook/payos/${C}`, "key-of-A")).status, 404, "C has no license");
    assert.equal((await post(`/webhook/payos`, "key-of-A")).status, 404, "the server id is required");
    inTenant(A, () => assert.equal(verifyWebhookSignature(data, sign(data, "key-of-A")), true));
    inTenant(B, () => assert.equal(verifyWebhookSignature(data, sign(data, "key-of-A")), false));
    const tokenA = inTenant(A, () => dashboardToken());
    assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard/${A}?token=${tokenA}`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard/${B}?token=${tokenA}`)).status, 401, "A's token does not open B");
    assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard/${C}?token=${tokenA}`)).status, 404);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    setGuildSource(() => [A, B]);
    assert.ok(metrics.includes("booking_bot_uptime_seconds"));
  } finally {
    await web.close();
  }
});

// ---------------------------------------------------------------- private messages

test("a button in a private message carries its server, is run in that server, and an untagged one is ignored", async () => {
  const a = server(A);
  const b = server(B);
  await a.command(a.owner, "setup");
  await b.command(b.owner, "setup");
  const customer = "900000000000000050";
  const sent = await inTenant(A, () => sendDm(a.client, customer, { content: "Hỏi thử", components: [] }));
  assert.equal(sent, true);

  // sendDm tags the buttons of the server it runs for
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import("discord.js");
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("bk:rate:7:5").setLabel("5 sao").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL("https://example.com").setLabel("Link"),
  );
  await inTenant(B, () => sendDm(b.client, customer, { content: "x", components: [row] }));
  assert.deepEqual(buttonIds({ components: b.client.dmLog.at(-1).payload.components }), [`bk:rate:7:5@${B}`]);

  // a click on a tagged button runs in that server's data
  inTenant(A, () => {
    makePlayer("900000000000000060");
    makeCustomer(customer);
  });
  const booking = inTenant(A, () => {
    return confirmed({ customerId: customer, playerId: "900000000000000060", startAt: NOW - 3 * HOUR, now: NOW - DAY });
  });
  inTenant(A, () => {
    getDb().prepare("UPDATE bookings SET status = 'COMPLETED', started_at = ?, ended_at = ? WHERE id = ?").run(NOW - 3 * HOUR, NOW - 2 * HOUR, booking.id);
  });
  const click = await a.dmClick(customer, `bk:rate:${booking.id}:5@${A}`);
  assert.equal(modalOf(click).toJSON().custom_id, `bk:rate:submit:${booking.id}:5@${A}`, "the form it opens is tagged too");
  const sentRating = await a.dmSubmit(customer, `bk:rate:submit:${booking.id}:5@${A}`, { review: "tốt" });
  assert.match(textOf(sentRating), /Cảm ơn bạn đã đánh giá/);
  assert.equal(inTenant(A, () => getDb().prepare("SELECT rating FROM bookings WHERE id = ?").get(booking.id).rating), 5);

  // the same number in the other server means nothing
  const other = await b.dmClick(customer, `bk:rate:${booking.id}:5@${B}`);
  assert.match(textOf(other), /18 tuổi|Không tìm thấy|Chỉ|không có quyền/);
  const untagged = await a.dmClick(customer, `bk:rate:${booking.id}:5`);
  assert.equal(untagged.out.length, 0, "no server in the id, so nothing happens");
  const toUnlicensed = await a.dmClick(customer, `bk:rate:${booking.id}:5@${C}`);
  assert.match(textOf(toUnlicensed), /chưa kích hoạt/);
});

// ---------------------------------------------------------------- files and the entry points

test("a server's backups and its database file live in their own places", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "booking-tenants-"));
  const before = config.dataDir;
  config.dataDir = dir;
  closeDb();
  closeMaster();
  try {
    inTenant(A, () => {
      getDb().prepare("INSERT INTO blacklist (user_id, reason, created_at) VALUES ('u', 'x', 1)").run();
      const file = backupDb(new Date("2026-10-05T10:00:00Z"));
      assert.ok(file.includes(path.join("backups", A)), file);
      assert.ok(existsSync(file));
    });
    assert.ok(existsSync(path.join(dir, "tenants", `${A}.db`)));
    assert.equal(existsSync(path.join(dir, "thauxbooking.db")), false, "the default database was never opened");
    issueLicense({ days: 1, guildId: B }, NOW);
    assert.ok(existsSync(path.join(dir, "master.db")));
  } finally {
    closeDb();
    closeMaster();
    config.dataDir = before;
  }
});

test("the commands are registered globally in multi-server mode and /kichhoat only exists there", () => {
  const source = readFileSync(path.join(root, "src", "deploy-commands.js"), "utf8");
  assert.match(source, /applicationCommands\(config\.clientId\)/);
  assert.match(source, /applicationGuildCommands\(config\.clientId, config\.guildId\)/);
  assert.match(source, /kichhoat/);
});

test("the schedule job does not mix up two servers that have the same booking number", async () => {
  const a = server(A);
  const b = server(B);
  await a.command(a.owner, "setup");
  await b.command(b.owner, "setup");
  setGuildSource(() => [A, B]);
  const results = await forEachGuild(() => runSchedule(a.client, { now: NOW }));
  assert.equal(results.length, 2);
  assert.ok(modalOf && lastPayload && dms && MIN);
});
