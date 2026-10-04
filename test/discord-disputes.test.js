import { NOW, HOUR, MIN, makePlayer, makeCustomer, confirmed, ledgerRows, sum, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, modalOf, buttonIds, lastPayload, P } from "./discord-fakes.js";
import { runSchedule } from "../src/jobs/schedule.js";
import { getBooking, getDispute, endOf, listOpenDisputes, parseResolution } from "../src/domain/bookings.js";
import { getPlayer } from "../src/domain/players.js";
import { activeStrikeCount, addStrike } from "../src/domain/strikes.js";
import { markPaid } from "../src/domain/ledger.js";
import { getSettings } from "../src/settings.js";
import { setClock } from "../src/discord/clock.js";
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

const START = NOW + 5 * HOUR;
const tick = (t) => runSchedule(env.client, { now: t });
const join = (voice, ...ids) => ids.forEach((id) => voice.members.set(id, { id }));
const rooms = (b) => {
  const fresh = getBooking(b.id);
  return { text: env.guild.channels.cache.get(fresh.text_channel_id), voice: env.guild.channels.cache.get(fresh.voice_channel_id) };
};

// A booking that ran its course: rooms opened, started on voice presence, completed at its end
async function session({ startAt = START, customerId = IDS.cust } = {}) {
  const b = confirmed({ customerId, playerId: IDS.player, startAt });
  await tick(startAt - 10 * MIN + 1000);
  join(rooms(b).voice, customerId, IDS.player);
  await tick(startAt + MIN);
  await tick(endOf(b));
  assert.equal(getBooking(b.id).status, "COMPLETED");
  setClock(() => endOf(b) + 5 * MIN);
  return b;
}

const reasons = { reason: "Player đến muộn 40 phút @everyone https://x.example" };

async function disputed(who = IDS.cust) {
  const b = await session();
  await env.submit(who, `bk:problem:submit:${b.id}`, reasons);
  return { b, dispute: getDispute(1), card: env.channel("disputesChannelId").sent.at(-1) };
}

// ---------------------------------------------------------------- opening

test("reporting a problem: a modal, a cleaned reason, a ticket for staff with three buttons, staff may join voice, money held", async () => {
  const b = await session();
  const open = await env.click(IDS.cust, `bk:problem:${b.id}`);
  assert.equal(modalOf(open).toJSON().custom_id, `bk:problem:submit:${b.id}`);
  assert.match(textOf(await env.click(IDS.cust2, `bk:problem:${b.id}`)), /Bạn cần xác nhận|không có quyền/);

  const done = await env.submit(IDS.cust, `bk:problem:submit:${b.id}`, reasons);
  assert.match(textOf(done), /Đã gửi báo cáo, nhân viên sẽ xem xét\. Khoản tiền của buổi này được giữ lại cho đến khi có kết quả\./);
  assert.equal(getBooking(b.id).status, "DISPUTED");
  const d = getDispute(1);
  assert.equal(d.status, "OPEN");
  assert.equal(d.opener_id, IDS.cust);
  assert.ok(!/everyone|x\.example/.test(d.reason));

  const ticket = env.channel("disputesChannelId").sent[0];
  assert.deepEqual(buttonIds({ components: ticket.components }), ["dp:resolve:1:pay_player", "dp:resolve:1:refund_customer", "dp:resolve:1:split"]);
  assert.match(JSON.stringify(ticket.embeds), /Khiếu nại #1 cho lịch #1/);
  assert.ok(!/everyone/.test(JSON.stringify(ticket.embeds)));
  assert.deepEqual(ticket.allowedMentions, { parse: [] });
  assert.match(dms(env.client, IDS.player).join("\n"), /có báo cáo sự cố/);

  const { voice, text } = rooms(b);
  assert.equal(voice.overwriteEdits[0].id, getSettings().roles.staffRoleId);
  assert.equal(voice.overwriteEdits[0].change.Connect, true);
  assert.equal(voice.userLimit, 3);
  assert.equal(text.deleted, false, "the rooms stay open for the dispute");
  await tick(endOf(b) + 20 * MIN);
  assert.equal(text.deleted, false, "and the scheduler does not close them");
});

test("a player may report too, a stranger and an early report are refused, and reports are rate limited", async () => {
  const b = await session();
  assert.match(textOf(await env.submit(IDS.rando, `bk:problem:submit:${b.id}`, reasons)), /xác nhận mình đủ 18 tuổi/);
  makeCustomer(IDS.rando);
  assert.match(textOf(await env.submit(IDS.rando, `bk:problem:submit:${b.id}`, reasons)), /không có quyền thực hiện thao tác này với lịch này/);
  const ok = await env.submit(IDS.player, `bk:problem:submit:${b.id}`, reasons);
  assert.match(textOf(ok), /Đã gửi báo cáo/);
  assert.equal(getDispute(1).opener_id, IDS.player);
  assert.match(dms(env.client, IDS.cust).join("\n"), /có báo cáo sự cố/);

  const early = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START + 10 * HOUR });
  assert.match(textOf(await env.submit(IDS.cust, `bk:problem:submit:${early.id}`, reasons)), /Chưa thể báo cáo sự cố cho lịch đang ở trạng thái "Đã xác nhận"/);
  let last;
  for (let n = 0; n < 5; n += 1) last = await env.submit(IDS.cust, `bk:problem:submit:${early.id}`, reasons);
  assert.match(textOf(last), /gửi báo cáo quá nhiều lần/);
});

// ---------------------------------------------------------------- resolving

test("resolving needs staff at every step, asks for confirmation, and closes the case completely", async () => {
  const { b, card } = await disputed();
  const click = (user, id) => env.click(user, id, card);
  for (const user of [IDS.rando, IDS.cust, IDS.player]) {
    assert.match(textOf(await click(user, "dp:resolve:1:pay_player")), /không có quyền/);
    assert.match(textOf(await click(user, `dp:do:1:pay_player:n:${card.id}`)), /không có quyền/);
  }
  assert.equal(getDispute(1).status, "OPEN");

  const ask = await click(IDS.staff, "dp:resolve:1:pay_player");
  assert.match(textOf(ask), /Trả đủ cho player\. Xác nhận quyết định này\?/);
  assert.deepEqual(buttonIds(lastPayload(ask)).map((id) => id.split(":")[3] + ":" + id.split(":")[4]), ["pay_player:n", "pay_player:p", "pay_player:c", "pay_player:x"]);
  assert.equal(getDispute(1).status, "OPEN", "asking decides nothing");

  const closing = rooms(b);
  const done = await click(IDS.staff, `dp:do:1:pay_player:n:${card.id}`);
  assert.match(textOf(done), /Đã xử lý khiếu nại #1: Trả đủ cho player\./);
  assert.equal(getDispute(1).status, "RESOLVED");
  assert.equal(parseResolution(getDispute(1)).outcome, "pay_player");
  assert.equal(getBooking(b.id).status, "DISPUTED");
  assert.equal(ledgerRows(b.id).some((r) => r.kind === "PLAYER_PAYOUT"), true);
  assert.equal(sum(ledgerRows(b.id)), b.price_vnd);

  assert.equal(closing.text.deleted, true);
  assert.equal(closing.voice.deleted, true);
  assert.deepEqual(card.components, []);
  assert.match(card.embeds[0].footer.text, /Trả đủ cho player bởi/);
  assert.match(dms(env.client, IDS.cust).join("\n"), /Khiếu nại đã xử lý: player được thanh toán đủ\./);
  assert.match(dms(env.client, IDS.player).join("\n"), /bạn được thanh toán đủ/);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Khiếu nại #1 \(lịch #1\): Trả đủ cho player/);
  assert.match(env.channel("bookingsLogChannelId").sent.at(-1).content, /xử lý bởi/);

  assert.match(textOf(await click(IDS.staff, "dp:resolve:1:pay_player")), /đã được xử lý rồi/);
  assert.match(textOf(await click(IDS.staff, `dp:do:1:refund_customer:n:${card.id}`)), /đã được xử lý rồi/);
  assert.equal(ledgerRows(b.id).some((r) => r.kind === "REFUND"), false, "a second click changes no money");
});

test("refunding the customer in full, with a strike for the player", async () => {
  const { b, card } = await disputed();
  await env.click(IDS.staff, `dp:do:1:refund_customer:p:${card.id}`, card);
  const rows = ledgerRows(b.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "REFUND");
  assert.equal(rows[0].amount_vnd, b.price_vnd);
  assert.equal(activeStrikeCount(IDS.player, NOW + 6 * HOUR), 1);
  assert.match(dms(env.client, IDS.cust).join("\n"), /Khiếu nại đã xử lý: bạn được hoàn 100%\./);
  assert.match(env.channel("bookingsLogChannelId").sent.at(-1).content, /phạt player/);
});

test("a split asks for the percent in a form, refuses a bad percent, and tells both sides the amounts", async () => {
  const { b, card } = await disputed();
  const open = await env.click(IDS.staff, "dp:resolve:1:split", card);
  const modal = modalOf(open).toJSON();
  assert.equal(modal.custom_id, `dp:split:submit:1:${card.id}`);
  assert.equal(modal.components[0].components[0].value, "50");

  assert.match(textOf(await env.submit(IDS.rando, modal.custom_id, { percent: "30", note: "" })), /không có quyền/);
  assert.match(textOf(await env.submit(IDS.staff, modal.custom_id, { percent: "100", note: "" })), /từ 1 đến 99/);
  assert.match(textOf(await env.submit(IDS.staff, modal.custom_id, { percent: "abc", note: "" })), /từ 1 đến 99/);
  assert.equal(getDispute(1).status, "OPEN");

  const done = await env.submit(IDS.staff, modal.custom_id, { percent: "30", note: "Cả hai cùng có lỗi @everyone" });
  assert.match(textOf(done), /Chia theo phần trăm/);
  assert.equal(ledgerRows(b.id).find((r) => r.kind === "REFUND").amount_vnd, 30_000);
  assert.equal(sum(ledgerRows(b.id)), b.price_vnd);
  assert.match(dms(env.client, IDS.cust).join("\n"), /hoàn 30% \(30\.000 đ\), phần còn lại trả cho player/);
  assert.ok(!/everyone/.test(parseResolution(getDispute(1)).note));
  assert.match(card.embeds[0].footer.text, /Chia theo phần trăm \(30%\)/);
});

test("clearing the strikes a booking caused is offered with the decision", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  await tick(START - 10 * MIN + 1000);
  join(rooms(b).voice, IDS.cust);
  await tick(START + 15 * MIN);
  await tick(START + 15 * MIN + 30_000);
  assert.equal(getBooking(b.id).status, "NO_SHOW_PLAYER");
  assert.equal(activeStrikeCount(IDS.player, START + 20 * MIN), 1);
  setClock(() => START + 20 * MIN);
  await env.submit(IDS.player, `bk:problem:submit:${b.id}`, { reason: "Tôi có mặt nhưng lỗi mạng" });
  const card = env.channel("disputesChannelId").sent[0];
  await env.click(IDS.staff, `dp:do:1:pay_player:x:${card.id}`, card);
  assert.equal(activeStrikeCount(IDS.player, START + 21 * MIN), 0);
});

test("a decision that pushes the player over the strike limit suspends them", async () => {
  addStrike(IDS.player, null, "a", NOW);
  addStrike(IDS.player, null, "b", NOW);
  env.guild.members.cache.get(IDS.player).roles.cache.set(env.role("playerRoleId"), { id: env.role("playerRoleId") });
  const { card } = await disputed();
  await env.click(IDS.staff, `dp:do:1:refund_customer:p:${card.id}`, card);
  assert.equal(getPlayer(IDS.player).status, "SUSPENDED");
  assert.equal(env.guild.members.cache.get(IDS.player).roles.cache.has(env.role("playerRoleId")), false);
  assert.match(env.channel("bookingsLogChannelId").sent.find((m) => /tạm khoá/.test(m.content ?? "")).content, /bị tạm khoá do 3 cảnh cáo/);
});

test("if a payout was already force-marked paid the refund is refused, staff are told to settle by hand and the case stays open", async () => {
  const b = await session();
  const payout = ledgerRows(b.id).find((r) => r.kind === "PLAYER_PAYOUT");
  markPaid(payout.id, IDS.owner, null, NOW + 6 * HOUR, { force: true });
  await env.submit(IDS.cust, `bk:problem:submit:${b.id}`, reasons);
  const card = env.channel("disputesChannelId").sent[0];
  const result = await env.click(IDS.staff, `dp:do:1:refund_customer:n:${card.id}`, card);
  assert.match(textOf(result), /đã được trả, không thể tính lại\. Hãy xử lý thủ công/);
  assert.equal(getDispute(1).status, "OPEN");
  assert.equal(listOpenDisputes().length, 1);
  assert.equal(rooms(b).text.deleted, false);
  assert.deepEqual(card.components.length > 0, true, "the buttons stay on the ticket");
});

// ---------------------------------------------------------------- a suspended player's upcoming bookings

test("the cancel-upcoming button is staff only, refunds every upcoming booking in full and tells the customers", async () => {
  const a = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START + 20 * HOUR });
  const c = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START + 30 * HOUR });
  assert.match(textOf(await env.click(IDS.rando, `dp:cancelupcoming:${IDS.player}`)), /không có quyền/);
  assert.equal(getBooking(a.id).status, "CONFIRMED");
  const done = await env.click(IDS.staff, `dp:cancelupcoming:${IDS.player}`);
  assert.match(textOf(done), /Đã huỷ 2 lịch sắp tới, ghi nợ hoàn 200\.000 đ cho khách\./);
  for (const x of [a, c]) {
    assert.equal(getBooking(x.id).status, "CANCELLED");
    assert.equal(ledgerRows(x.id).find((r) => r.kind === "REFUND").amount_vnd, x.price_vnd);
  }
  assert.equal(dms(env.client, IDS.cust).filter((t) => /đã bị huỷ/.test(t)).length, 2);
  assert.match(textOf(await env.click(IDS.staff, `dp:cancelupcoming:${IDS.player}`)), /Không có lịch sắp tới nào cần huỷ/);
  assert.ok(MIN && P && getDb);
});
