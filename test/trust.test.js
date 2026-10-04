import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, confirmed, book, getDb, fresh } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, buttonIds, lastPayload } from "./discord-fakes.js";
import { runSchedule } from "../src/jobs/schedule.js";
import { getBooking, endOf, getDispute, SYSTEM } from "../src/domain/bookings.js";
import * as bk from "../src/domain/bookings.js";
import { getPlayer } from "../src/domain/players.js";
import { addStrike, addToBlacklist } from "../src/domain/strikes.js";
import { addReport } from "../src/domain/people.js";
import { customerRating, customerRisk, openSafetyAlerts, rateCustomer, recordSafetyAlert, unverifyPlayer, verifyPlayer } from "../src/domain/trust.js";
import { setClock } from "../src/discord/clock.js";
import { refreshCard, buildCard } from "../src/discord/cards.js";

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code ?? `plain:${e.message}`;
  }
  return "no error";
};

// ---------------------------------------------------------------- domain

function completed({ customerId = "c1", playerId = "p1", startAt = NOW + 3 * HOUR } = {}) {
  const b = book({ customerId, playerId, startAt, durationMin: 60 });
  bk.pay(b.id, NOW, b.price_vnd);
  bk.start(b.id, SYSTEM, startAt);
  return bk.complete(b.id, SYSTEM, startAt + HOUR);
}

test("staff can verify and unverify a player, and a stranger cannot be verified", () => {
  fresh();
  makePlayer("p1");
  assert.equal(getPlayer("p1").verifiedAt, null);
  const at = verifyPlayer("p1", "staff1", NOW);
  assert.equal(at, NOW);
  assert.equal(verifyPlayer("p1", "staff2", NOW + 1), NOW, "the first time is kept");
  assert.equal(getPlayer("p1").verifiedAt, NOW);
  assert.equal(code(() => verifyPlayer("nobody", "staff1", NOW)), "NOT_FOUND");
  assert.equal(unverifyPlayer("p1"), true);
  assert.equal(unverifyPlayer("p1"), false);
  assert.equal(getPlayer("p1").verifiedAt, null);
});

test("a safety alert is for the two people of a live booking only", () => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  makeCustomer("c2");
  const b = confirmed({ customerId: "c1", playerId: "p1" });
  assert.equal(code(() => recordSafetyAlert(b.id, "c2", NOW)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => recordSafetyAlert(999, "c1", NOW)), "NOT_FOUND");
  const { alert } = recordSafetyAlert(b.id, "c1", NOW);
  assert.equal(openSafetyAlerts().length, 1);
  assert.equal(alert.user_id, "c1");
  const old = completed({ customerId: "c2", startAt: NOW + 5 * HOUR });
  assert.equal(code(() => recordSafetyAlert(old.id, "c2", old.ended_at + 2 * DAY)), "ILLEGAL_TRANSITION", "a day after the end the alarm is closed");
  assert.ok(recordSafetyAlert(old.id, "c2", old.ended_at + HOUR).alert);
});

test("a player rates the customer once, for a completed session of theirs", () => {
  fresh();
  makePlayer("p1");
  makePlayer("p2");
  makeCustomer("c1");
  const open = confirmed({ customerId: "c1", playerId: "p1", startAt: NOW + 6 * HOUR });
  assert.equal(code(() => rateCustomer(open.id, "p1", 5, "", NOW)), "INVALID_INPUT", "not finished");
  const done = completed();
  assert.equal(code(() => rateCustomer(done.id, "p2", 5, "", done.ended_at)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => rateCustomer(done.id, "p1", 6, "", done.ended_at)), "BAD_STARS");
  rateCustomer(done.id, "p1", 4, "lịch sự https://x.example", done.ended_at);
  assert.equal(code(() => rateCustomer(done.id, "p1", 5, "", done.ended_at)), "INVALID_INPUT", "once");
  assert.deepEqual(customerRating("c1"), { count: 1, average: 4 });
  assert.ok(!/x\.example/.test(getDb().prepare("SELECT note FROM customer_ratings").get().note), "the note is cleaned");
});

test("risk starts low and rises with real facts, each with its reason", () => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  const first = customerRisk("c1", NOW);
  assert.equal(first.level, "LOW");
  assert.match(first.reasons.join("|"), /khách mới/);
  const done = completed();
  assert.equal(customerRisk("c1", NOW + DAY).points, 0, "a customer with a finished session has no mark against them");
  addStrike("c1", null, "đến trễ", NOW + DAY);
  addStrike("c1", null, "đến trễ", NOW + DAY + 1);
  const struck = customerRisk("c1", NOW + DAY);
  assert.equal(struck.level, "MEDIUM");
  assert.match(struck.reasons.join("|"), /2 cảnh cáo/);
  addReport({ reporterId: "x1", aboutUserId: "c1", text: "nói chuyện không phù hợp với player" }, NOW);
  recordSafetyAlert(done.id, "p1", done.ended_at + 1000);
  const worse = customerRisk("c1", NOW + DAY);
  assert.equal(worse.level, "HIGH");
  assert.ok(worse.reasons.length >= 3);
  addToBlacklist("c1", "test", "staff1", NOW);
  assert.equal(customerRisk("c1", NOW + DAY).points >= 100, true);
});

test("low player ratings count against a customer only once there are two", () => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  const a = completed({ startAt: NOW + 3 * HOUR });
  rateCustomer(a.id, "p1", 1, "", a.ended_at);
  assert.ok(!customerRisk("c1", a.ended_at).reasons.some((r) => /chấm trung bình/.test(r)));
  const b = completed({ startAt: NOW + 6 * HOUR });
  rateCustomer(b.id, "p1", 2, "", b.ended_at);
  assert.ok(customerRisk("c1", b.ended_at).reasons.some((r) => /chấm trung bình/.test(r)));
});

// ---------------------------------------------------------------- Discord

let env;
const START = NOW + 5 * HOUR;
const tick = (t) => runSchedule(env.client, { now: t });
const join = (voice, ...ids) => ids.forEach((id) => voice.members.set(id, { id }));
const rooms = (b) => {
  const fresh_ = getBooking(b.id);
  return { text: env.guild.channels.cache.get(fresh_.text_channel_id), voice: env.guild.channels.cache.get(fresh_.voice_channel_id) };
};

async function boot2() {
  env = await boot();
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
}

async function running() {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  await tick(START - 10 * MIN + 1000);
  join(rooms(b).voice, IDS.cust, IDS.player);
  await tick(START + MIN);
  assert.equal(getBooking(b.id).status, "IN_PROGRESS");
  setClock(() => START + 10 * MIN);
  return b;
}

beforeEach(boot2);

test("the alert button: staff and owners are told, the case is frozen, strangers are refused", async () => {
  const b = await running();
  assert.match(textOf(await env.click(IDS.rando, `sf:alert:${b.id}`)), /Bạn cần xác nhận|không có quyền/);
  assert.equal(openSafetyAlerts().length, 0);

  const answer = await env.click(IDS.cust, `sf:alert:${b.id}`);
  assert.match(textOf(answer), /Đã báo khẩn cho nhân viên/);
  assert.equal(openSafetyAlerts().length, 1);
  assert.equal(getBooking(b.id).status, "DISPUTED", "money is frozen like in any complaint");
  assert.equal(getDispute(1).status, "OPEN");

  const posted = env.channel("disputesChannelId").sent;
  assert.match(JSON.stringify(posted[0].embeds), /BÁO KHẨN cho lịch #1/);
  assert.deepEqual(buttonIds({ components: posted[0].components }), ["sf:done:1"]);
  assert.ok(posted.some((m) => /Khiếu nại #1/.test(JSON.stringify(m.embeds))), "the ordinary dispute ticket follows");
  for (const m of posted) assert.deepEqual(m.allowedMentions, { parse: [] });

  assert.match(textOf(await env.click(IDS.cust2, "sf:done:1")), /không có quyền/);
  assert.equal(openSafetyAlerts().length, 1);
  assert.match(textOf(await env.click(env.staff, "sf:done:1")), /đã xử lý/);
  assert.equal(openSafetyAlerts().length, 0);
});

test("the alert button is in the room's welcome message, and works before the session starts", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  await tick(START - 10 * MIN + 1000);
  const welcome = rooms(b).text.sent[0];
  assert.ok(buttonIds({ components: welcome.components }).includes(`sf:alert:${b.id}`));
  setClock(() => START - 5 * MIN);
  assert.match(textOf(await env.click(IDS.player, `sf:alert:${b.id}`)), /Đã báo khẩn/);
  assert.equal(getBooking(b.id).status, "CONFIRMED", "nothing to freeze yet, staff are only told");
});

test("after a session the player is asked to rate the customer, and the answer reaches staff only", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  await tick(START - 10 * MIN + 1000);
  join(rooms(b).voice, IDS.cust, IDS.player);
  await tick(START + MIN);
  await tick(endOf(b));
  setClock(() => endOf(b) + MIN);
  await tick(endOf(b) + MIN);
  const prompt = env.client.dmLog.find((d) => d.userId === IDS.player && /thế nào/.test(d.payload.content ?? ""));
  assert.ok(prompt, "the player got the question");
  assert.deepEqual(buttonIds({ components: prompt.payload.components }), [1, 2, 3, 4, 5].map((n) => `cr:rate:${b.id}:${n}`));
  const answer = await env.dmClick(IDS.player, `cr:rate:${b.id}:5`);
  assert.match(textOf(answer), /Chỉ nhân viên thấy/);
  assert.deepEqual(customerRating(IDS.cust), { count: 1, average: 5 });
  assert.match(textOf(await env.dmClick(IDS.player, `cr:rate:${b.id}:4`)), /đã đánh giá khách/);
  assert.match(textOf(await env.dmClick(IDS.cust, `cr:rate:${b.id}:4`)), /Chỉ player đã được duyệt|không có quyền/);
});

test("/staff xac-minh puts the badge on the card, bo-xac-minh removes it, and only staff may", async () => {
  assert.match(textOf(await env.command(IDS.cust, "staff", { subcommand: "xac-minh", opts: { user: { id: IDS.player } } })), /không có quyền/);
  assert.equal(getPlayer(IDS.player).verifiedAt, null);
  const done = await env.command(env.staff, "staff", { subcommand: "xac-minh", opts: { user: { id: IDS.player } } });
  assert.match(textOf(done), /Đã xác minh/);
  assert.ok(getPlayer(IDS.player).verifiedAt);
  assert.match(JSON.stringify(buildCard(getPlayer(IDS.player)).embeds), /Đã xác minh/);
  await env.command(env.staff, "staff", { subcommand: "bo-xac-minh", opts: { user: { id: IDS.player } } });
  assert.ok(!/Đã xác minh/.test(JSON.stringify(buildCard(getPlayer(IDS.player)).embeds)));
});

test("/staff xem-khach shows the risk level with its reasons and what players said", async () => {
  addStrike(IDS.cust, null, "đến trễ", NOW);
  const shown = textOf(await env.command(env.staff, "staff", { subcommand: "xem-khach", opts: { user: { id: IDS.cust } } }));
  assert.match(shown, /Mức rủi ro/);
  assert.match(shown, /1 cảnh cáo còn hiệu lực/);
  assert.match(shown, /Player chấm khách/);
});
