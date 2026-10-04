import { NOW, HOUR, MIN, makePlayer, makeCustomer, confirmed, getDb, ledgerRows } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot, IDS, loadModules } from "./discord-env.js";
import { textOf, modalOf } from "./discord-fakes.js";
import { attest } from "../src/domain/attestations.js";
import { refreshCard } from "../src/discord/cards.js";
import { createRouter } from "../src/discord/router.js";
import { resetLimits, hit } from "../src/discord/limits.js";
import { setClock } from "../src/discord/clock.js";
import { getBooking, getDispute } from "../src/domain/bookings.js";
import { getPlayer } from "../src/domain/players.js";
import { config } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
});

const snapshot = () => {
  const db = getDb();
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return JSON.stringify({
    ledger: db.prepare("SELECT id, status FROM ledger").all(),
    bookings: db.prepare("SELECT id, status FROM bookings").all(),
    players: db.prepare("SELECT user_id, status FROM players").all(),
    n: ["strikes", "blacklist", "disputes", "orders"].map(count),
    settings: db.prepare("SELECT data FROM settings").get(),
  });
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- contract with stage 1

test("contract: every domain function the Discord layer calls still exists under the same name", async () => {
  const expected = {
    "attestations.js": ["attest", "hasAttested", "isAttestPhrase", "ATTEST_PHRASE"],
    "players.js": ["applyAsPlayer", "approvePlayer", "rejectPlayer", "pausePlayer", "resumePlayer", "suspendPlayer", "updateProfile", "setProfileMessage", "getPlayer", "listPlayers", "setAvailabilityText"],
    "availability.js": ["formatAvailability", "getAvailability"],
    "time.js": ["parseLocalDateTime", "formatLocal", "localParts", "startOfLocalDay"],
    "pricing.js": ["parseDurationText", "formatVnd", "quote"],
    "bookings.js": ["createBooking", "pay", "expireUnpaid", "start", "complete", "cancel", "noShow", "openDispute", "resolveDispute", "actorFor", "SYSTEM", "staffActor", "canTransition", "setRooms", "getBooking", "listBookings", "cancelUpcomingForPlayer", "getDispute", "listOpenDisputes", "endOf"],
    "policy.js": ["refundFor"],
    "ledger.js": ["owedTo", "pendingRefunds", "pendingPayouts", "markPaid", "summary", "getLedgerRow"],
    "ratings.js": ["recordRating", "playerRating", "trustedRoleChanges", "regularCustomerChanges", "sanitizeText", "isTrusted"],
    "strikes.js": ["addStrike", "liftSuspension", "activeStrikeCount", "listStrikes", "addToBlacklist", "removeFromBlacklist", "isBlacklisted", "listBlacklist"],
    "schedule.js": ["loadScheduleState", "dueActions", "markActionDone"],
    "summary.js": ["ownerSummary", "playerEarnings"],
  };
  for (const [file, names] of Object.entries(expected)) {
    const mod = await import(`../src/domain/${file}`);
    for (const name of names) assert.ok(name in mod, `${file} exports ${name}`);
  }
  const orders = await import("../src/pay/orders.js");
  for (const name of ["createBookingOrder", "setCheckoutUrl", "closeOrder", "recentOrders"]) assert.equal(typeof orders[name], "function", name);
  const payos = await import("../src/pay/payos.js");
  for (const name of ["createPaymentLink", "payosEnabled"]) assert.equal(typeof payos[name], "function", name);
  const settings = await import("../src/settings.js");
  for (const name of ["getSettings", "patchSettings", "saveSettings", "normalizeSettings"]) assert.equal(typeof settings[name], "function", name);
});

// ---------------------------------------------------------------- the commands themselves

test("the command definitions: hidden where they should be, never in DMs, no role options, unique and short", async () => {
  const modules = (await loadModules()).filter((m) => m.data);
  const json = modules.map((m) => m.data.toJSON());
  const names = json.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), ["admin", "bangxephang", "baocao", "chuyentien", "datlich", "gioithieu", "hangcho", "kichhoat", "lichcuatoi", "lichranh", "magiamgia", "nganhang", "ngonngu", "player", "setup", "staff", "thanhvien", "thunhap", "timplayer", "vi"]);
  const optionTypes = (opts = []) => opts.flatMap((o) => [o.type, ...optionTypes(o.options)]);
  for (const c of json) {
    assert.equal(c.dm_permission, false, `${c.name} is not usable in DMs`);
    assert.ok(c.description.length <= 100 && c.description.length > 0);
    assert.ok(!optionTypes(c.options).includes(8), `${c.name} takes no role option`);
  }
  for (const name of ["setup", "admin", "staff", "chuyentien", "magiamgia", "kichhoat"]) assert.equal(json.find((c) => c.name === name).default_member_permissions, "0", `${name} is hidden by default`);
  for (const name of ["datlich", "lichcuatoi", "lichranh", "thunhap", "player"]) assert.equal(json.find((c) => c.name === name).default_member_permissions ?? null, null);
});

test("deploy-commands registers exactly the modules that have command data", () => {
  const source = readFileSync(path.join(root, "src", "deploy-commands.js"), "utf8");
  assert.match(source, /command\?\.data/);
  assert.match(source, /applicationGuildCommands/);
});

// ---------------------------------------------------------------- permission matrix

const STAFF_BUTTONS = [
  "pl:approve:900000000000000005",
  "pl:reject:900000000000000005",
  "dp:resolve:1:pay_player",
  "dp:resolve:1:split",
  "dp:do:1:refund_customer:p:0",
  "dp:cancelupcoming:900000000000000005",
];
const OWNER_BUTTONS = ["mn:paid:1", "mn:paid:yes:1", "mn:force:1", "mn:force:yes:1"];
const STAFF_MODALS = [["pl:reject:submit:900000000000000005", { reason: "x" }], ["dp:split:submit:1:0", { percent: "50", note: "" }]];
const OWNER_MODALS = [["ad:settings:phi", { feePercent: "50", maxDurationHours: "1", maxActiveBookings: "1", minRateVnd: "1000", maxRateVnd: "9000" }], ["ad:settings:huy", { cancellation: "0h 0", ownerNotes: "x" }]];

test("permission matrix: forged buttons and modals from a stranger, a customer and a player change nothing", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR });
  const { start, complete, SYSTEM, openDispute, staffActor } = await import("../src/domain/bookings.js");
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  complete(b.id, SYSTEM, NOW + 3 * HOUR);
  openDispute(b.id, staffActor("s"), "x", NOW + 3 * HOUR);
  attest(IDS.rando, NOW);
  const before = snapshot();
  for (const user of [IDS.rando, IDS.cust, IDS.player]) {
    for (const id of [...STAFF_BUTTONS, ...OWNER_BUTTONS]) {
      const i = await env.click(user, id);
      assert.match(textOf(i), /không có quyền/, `${id} for ${user}`);
      assert.equal(modalOf(i), undefined);
    }
    for (const [id, fields] of [...STAFF_MODALS, ...OWNER_MODALS]) {
      const i = await env.submit(user, id, fields);
      assert.match(textOf(i), /không có quyền/, `${id} for ${user}`);
    }
    resetLimits();
  }
  assert.equal(snapshot(), before);
  assert.equal(getDispute(1).status, "OPEN");

  // staff pass the staff gate but not the owner gate
  for (const id of OWNER_BUTTONS) assert.match(textOf(await env.click(IDS.staff, id)), /không có quyền/, id);
  for (const [id, fields] of OWNER_MODALS) assert.match(textOf(await env.submit(IDS.staff, id, fields)), /không có quyền/, id);
  assert.equal(snapshot(), before);
  assert.ok(getBooking(b.id));
});

test("a booking button forged for someone else's booking is refused for cancel, rate and problem", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  makeCustomer(IDS.cust2);
  const before = snapshot();
  for (const id of [`bk:cancel:${b.id}`, `bk:cancel:yes:${b.id}`, `bk:problem:${b.id}`, `bk:rate:${b.id}:5`]) {
    assert.match(textOf(await env.click(IDS.cust2, id)), /không có quyền thực hiện thao tác này với lịch này/, id);
  }
  for (const id of [`bk:problem:submit:${b.id}`, `bk:rate:submit:${b.id}:5`]) {
    assert.match(textOf(await env.submit(IDS.cust2, id, { reason: "x", review: "x" })), /không có quyền thực hiện thao tác này với lịch này|đánh giá/, id);
  }
  assert.equal(snapshot(), before);
});

test("owner means Administrator or OWNER_IDS, nothing else", async () => {
  attest(IDS.rando, NOW);
  assert.match(textOf(await env.command(IDS.rando, "chuyentien")), /không có quyền/);
  config.ownerIds.push(IDS.rando);
  try {
    assert.match(textOf(await env.command(IDS.rando, "chuyentien")), /Việc chuyển tiền/);
  } finally {
    config.ownerIds.pop();
  }
});

// ---------------------------------------------------------------- the router

test("the router ignores other servers and unknown ids, finds the longest prefix, and limits rapid clicking", async () => {
  const foreign = await env.router.dispatch((await import("./discord-fakes.js")).makeInteraction(env.world, { id: IDS.cust }, { kind: "button", customId: "age:open", guildId: "999999999999999999" }));
  assert.equal(foreign, false);
  assert.equal((await env.click(IDS.cust, "zzz:unknown:1")).out.length, 0);

  const calls = [];
  const router = createRouter([
    { buttons: { "x:a": () => calls.push("short"), "x:a:b": () => calls.push("long"), "x:c": (i, args) => calls.push(args.join("|")) } },
  ]);
  const { makeInteraction } = await import("./discord-fakes.js");
  for (const id of ["x:a:1", "x:a:b:2", "x:c:7:8", "x:ab"]) await router.dispatch(makeInteraction(env.world, { id: IDS.cust }, { kind: "button", customId: id }));
  assert.deepEqual(calls, ["short", "long", "7|8"], "x:ab is not x:a");

  resetLimits();
  let last;
  for (let n = 0; n < 16; n += 1) last = await env.click(IDS.rando, "zzz:unknown:1");
  assert.match(textOf(last), /thao tác nhanh quá/);
  assert.equal(hit("k", 1, 1000, 0), true);
  assert.equal(hit("k", 1, 1000, 500), false);
  assert.equal(hit("k", 1, 1000, 1500), true, "the window slides");
});

test("a domain error is shown as is, any other error becomes the generic line without leaking details", async () => {
  const { DomainError } = await import("../src/domain/errors.js");
  const { makeInteraction } = await import("./discord-fakes.js");
  const withRouter = createRouter([
    { buttons: { "t:domain": () => { throw new DomainError("TOO_LATE"); }, "t:crash": () => { throw new Error("secret-token-abc failed at /srv/app"); } } },
  ]);
  const a = makeInteraction(env.world, { id: IDS.cust }, { kind: "button", customId: "t:domain" });
  await withRouter.dispatch(a);
  assert.match(textOf(a), /Đã quá thời hạn cho thao tác này/);
  const original = console.error;
  console.error = () => {};
  const b = makeInteraction(env.world, { id: IDS.cust }, { kind: "button", customId: "t:crash" });
  try {
    await withRouter.dispatch(b);
  } finally {
    console.error = original;
  }
  assert.equal(textOf(b), "Có lỗi xảy ra, thử lại sau nhé.");
  assert.ok(!textOf(b).includes("secret"));

  const failing = createRouter([{ data: { name: "boom" }, autocomplete: () => { throw new Error("x"); } }]);
  const auto = makeInteraction(env.world, { id: IDS.cust }, { kind: "autocomplete", commandName: "boom" });
  console.error = () => {};
  try {
    await failing.dispatch(auto);
  } finally {
    console.error = original;
  }
  assert.deepEqual(auto.out[0].choices, []);
});

// ---------------------------------------------------------------- privacy and mentions

test("answers that carry private data are ephemeral", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  const priv = (i) => i.out.every((o) => o.type === "modal" || o.type === "autocomplete" || (o.type === "defer" ? o.payload.flags : o.type === "edit" ? true : o.payload?.flags));
  const cases = [
    await env.command(IDS.cust, "lichcuatoi"),
    await env.command(IDS.player, "thunhap"),
    await env.command(IDS.player, "lichranh", { opts: { lich: "T2 19:00-20:00" } }),
    await env.command(IDS.owner, "chuyentien"),
    await env.command(IDS.staff, "staff", { subcommand: "tong-ket" }),
    await env.command(IDS.staff, "staff", { subcommand: "duyet" }),
    await env.click(IDS.cust, `bk:cancel:${b.id}`),
    await env.click(IDS.cust, "bk:pick"),
    await env.command(IDS.rando, "thunhap"),
    await env.click(IDS.rando, "mn:paid:1"),
  ];
  for (const i of cases) assert.ok(priv(i), JSON.stringify(i.out.map((o) => [o.type, o.payload?.flags])));
});

test("nothing the bot sends can ping a role or everyone: hostile text through every input ends up clean and every send names its mentions", async () => {
  const hostile = "@everyone @here <@&123456789012345678> <@111111111111111111> https://evil.example discord.gg/abc";
  attest(IDS.player2, NOW);
  await env.submit(IDS.player2, "pl:apply:submit", { name: hostile, games: `LoL, ${hostile}`, rate: "100000", bio: hostile, languages: hostile });
  const queue = env.channel("applicationsChannelId").sent[0];
  await env.submit(IDS.staff, `pl:reject:submit:${IDS.player2}`, { reason: hostile }, queue);
  await env.command(IDS.staff, "staff", { subcommand: "phat", opts: { user: { id: IDS.player }, "ly-do": hostile } });
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR });
  const { start, complete, SYSTEM } = await import("../src/domain/bookings.js");
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  complete(b.id, SYSTEM, NOW + 3 * HOUR);
  setClock(() => NOW + 3 * HOUR + MIN);
  await env.submit(IDS.cust, `bk:rate:submit:${b.id}:3`, { review: hostile });
  await env.submit(IDS.cust, `bk:problem:submit:${b.id}`, { reason: hostile });
  await env.submit(IDS.staff, "dp:split:submit:1:0", { percent: "40", note: hostile });

  const bad = /@everyone|@here|<@&|evil\.example|discord\.gg|<@111111111111111111>/;
  const texts = [];
  for (const channel of env.guild.channels.cache.values()) {
    for (const m of channel.sent) {
      texts.push(`${m.content ?? ""} ${JSON.stringify(m.embeds ?? [])}`);
      assert.ok(m.allowedMentions, `a message in #${channel.name} sets allowedMentions`);
      assert.deepEqual(m.allowedMentions.parse, [], `no automatic parsing in #${channel.name}`);
    }
  }
  for (const d of env.client.dmLog) {
    texts.push(typeof d.payload === "string" ? d.payload : d.payload.content ?? "");
    assert.ok(d.payload.allowedMentions?.parse?.length === 0, "DMs parse no mentions");
  }
  for (const text of texts) assert.doesNotMatch(text, bad);
  assert.doesNotMatch(JSON.stringify(getPlayer(IDS.player2) ?? {}), bad);
  assert.doesNotMatch(JSON.stringify(getDb().prepare("SELECT reason FROM strikes").all()), bad);
  assert.doesNotMatch(JSON.stringify(getDb().prepare("SELECT reason FROM disputes").all()), bad);
  assert.doesNotMatch(JSON.stringify(getDb().prepare("SELECT review FROM bookings").all()), bad);
  assert.doesNotMatch(JSON.stringify(getDb().prepare("SELECT resolution FROM disputes").all()), bad);
  assert.ok(ledgerRows(b.id).length >= 1);
});

test("custom ids stay inside Discord's 100 character limit even with the longest parts", async () => {
  const id = "900000000000000005";
  const longest = [`pl:reject:submit:${id}`, `dp:do:999999:refund_customer:x:${id}`, `dp:split:submit:999999:${id}`, `bk:rate:submit:999999:5`, `mn:force:yes:999999`, `dp:cancelupcoming:${id}`];
  for (const cid of longest) assert.ok(cid.length <= 100, cid);
});

// ---------------------------------------------------------------- source hygiene

test("static checks on the Discord layer: no message content, no members or presence intents, no role options, no bare replies", () => {
  const sources = walk(path.join(root, "src")).filter((f) => f.endsWith(".js"));
  const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of sources) {
    const rel = path.relative(root, file).replace(/\\/g, "/");
    const code = withoutComments(readFileSync(file, "utf8"));
    assert.doesNotMatch(code, /MessageContent|GuildMembers|GuildPresences/, `${rel} requests no privileged intent`);
    assert.doesNotMatch(code, /addRoleOption|ApplicationCommandOptionType\.Role/, `${rel} has no role option`);
    assert.doesNotMatch(code, /roles\.(add|remove)\(\s*(interaction|option|values)/, `${rel} never grants a role taken from input`);
    assert.doesNotMatch(code, /parse:\s*\[\s*["'](everyone|roles|users)/, `${rel} never allows automatic mention parsing`);
    if (!rel.endsWith("discord/respond.js") && !rel.includes("/commands/")) assert.doesNotMatch(code, /interaction\.reply\(/, `${rel} replies through respond()`);
    assert.doesNotMatch(code, /\.content\b.*message\.(content|cleanContent)|message\.content/, `${rel} does not read message content`);
  }
  assert.equal(existsSync(path.join(root, "src", "events", "messageCreate.js")), false, "no message event");
  assert.deepEqual(readdirSync(path.join(root, "src", "events")).sort(), ["interactionCreate.js", "voiceStateUpdate.js"]);
});

test("every role the bot can touch goes through the allowlist in roles.js", () => {
  const roles = readFileSync(path.join(root, "src", "discord", "roles.js"), "utf8");
  assert.match(roles, /verified: "verifiedRoleId"/);
  assert.match(roles, /player: "playerRoleId"/);
  assert.match(roles, /trusted: "trustedPlayerRoleId"/);
  assert.match(roles, /regular: "regularCustomerRoleId"/);
  assert.doesNotMatch(roles, /staffRoleId/);
  const direct = walk(path.join(root, "src")).filter((f) => f.endsWith(".js") && !f.endsWith("roles.js") && !f.includes("layout.js"));
  for (const file of direct) assert.doesNotMatch(readFileSync(file, "utf8"), /\.roles\.(add|remove)\(/, `${path.relative(root, file)} must use grantRole or revokeRole`);
});
