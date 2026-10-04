import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, vn, getDb, getSettings, saveSettings } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, modalOf, buttonIds, lastPayload } from "./discord-fakes.js";
import { config } from "../src/config.js";
import { checkPayments } from "../src/jobs/payments.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { resetLimits } from "../src/discord/limits.js";
import { getBooking, complete, SYSTEM } from "../src/domain/bookings.js";
import { getPlayer } from "../src/domain/players.js";
import { getOrder } from "../src/pay/orders.js";
import { hasAttested } from "../src/domain/attestations.js";
import { listStrikes } from "../src/domain/strikes.js";

let env;
let calls;
beforeEach(async () => {
  env = await boot();
  calls = [];
  makePlayer(IDS.player, { rateVnd: 100_000 });
  makeCustomer(IDS.cust);
  makeCustomer(IDS.cust2);
  env.guild.addMember({ id: IDS.player });
  await refreshCard(env.guild, IDS.player);
});
afterEach(() => {
  globalThis.fetch = undefined;
  setClock(() => NOW);
});

const payosOk = (status = "PENDING") => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const body = String(url).endsWith("/v2/payment-requests")
      ? { code: "00", data: { checkoutUrl: "https://pay.payos.vn/web/abc", paymentLinkId: "abc" } }
      : { code: "00", data: { status, amount: 100_000, amountPaid: status === "PAID" ? 100_000 : 0 } };
    return { ok: true, status: 200, json: async () => body };
  };
};

const form = { game: "liên quân", when: "05/10 19:00", duration: "1" };
const order = (customer = IDS.cust, fields = form, player = IDS.player) => env.submit(customer, `bk:new:${player}`, fields);
const silently = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

// ---------------------------------------------------------------- the happy path

test("a booking from a profile card: modal, quote, payOS link, payment detected, both people told, logs written", async () => {
  payosOk();
  const open = await env.click(IDS.cust, `pl:book:${IDS.player}`);
  const fields = modalOf(open).toJSON().components.map((r) => r.components[0]);
  assert.deepEqual(fields.map((f) => f.custom_id), ["game", "when", "duration", "coupon", "repeat"]);
  assert.match(fields[0].placeholder, /Liên Quân/);
  assert.match(fields[1].placeholder, /12\/10 19:30/);

  const made = await order();
  const embed = lastPayload(made).embeds[0].toJSON();
  assert.match(embed.title, /Lịch #1 chờ thanh toán/);
  assert.ok(embed.fields.some((f) => f.name === "Giá" && f.value === "100.000 đ"));
  assert.ok(embed.fields.some((f) => f.name === "Thời gian" && /T2 05\/10 19:00/.test(f.value)));
  assert.match(embed.footer.text, /Thanh toán trong 30 phút/);
  const buttons = lastPayload(made).components[0].toJSON().components;
  assert.equal(buttons[0].url, "https://pay.payos.vn/web/abc");
  assert.equal(buttons[1].custom_id, "bk:cancel:1");
  assert.ok(made.out[0].type === "defer" && made.out[0].payload.flags, "private");

  const b = getBooking(1);
  assert.equal(b.status, "AWAITING_PAYMENT");
  assert.equal(b.game, "Liên Quân", "the game is stored as the player spells it");
  assert.equal(getOrder(b.order_code).checkout_url, "https://pay.payos.vn/web/abc");
  assert.equal(calls[0].body.amount, 100_000);
  assert.equal(calls[0].body.returnUrl, config.returnUrl);

  // The customer pays: the job confirms and the Discord layer announces
  payosOk("PAID");
  const result = await checkPayments(env.client, NOW + 2 * MIN);
  assert.equal(result.paid, 1);
  assert.equal(getBooking(1).status, "CONFIRMED");
  assert.match(dms(env.client, IDS.cust).join("\n"), /Đã nhận thanh toán\. Lịch #1 với Player 900000000000000005 lúc T2 05\/10 19:00 đã được xác nhận\./);
  assert.match(dms(env.client, IDS.player).join("\n"), /Bạn có lịch mới: <@900000000000000003> chơi Liên Quân lúc T2 05\/10 19:00, 1 giờ\./);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Nhận 100\.000 đ cho lịch #1\./);
  assert.match(env.channel("bookingsLogChannelId").sent.at(-1).content, /Lịch #1 đã xác nhận/);
});

test("when the customer's DMs are closed the confirmation goes to the log channel with a mention of that person only", async () => {
  payosOk();
  await order();
  env.client.closedDms.add(IDS.cust);
  payosOk("PAID");
  await checkPayments(env.client, NOW + MIN);
  const log = env.channel("bookingsLogChannelId").sent.find((m) => /không gửi được tin nhắn riêng/.test(m.content));
  assert.ok(log);
  assert.deepEqual(log.allowedMentions, { parse: [], users: [IDS.cust] });
});

test("a payment that arrives after the booking expired is announced as a late refund", async () => {
  payosOk();
  await order();
  const { expireUnpaid } = await import("../src/domain/bookings.js");
  expireUnpaid(1, NOW + 31 * MIN);
  payosOk("PAID");
  await checkPayments(env.client, NOW + 32 * MIN);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Tiền về muộn cho lịch #1 \(100\.000 đ\), đã ghi nợ hoàn tiền\./);
  assert.match(dms(env.client, IDS.cust).join("\n"), /chủ server sẽ chuyển lại cho bạn/);
});

test("a link that closed with only part paid raises a warning in the money log", async () => {
  payosOk();
  await order();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: "00", data: { status: "EXPIRED", amount: 100_000, amountPaid: 40_000 } }) });
  await checkPayments(env.client, NOW + 31 * MIN);
  const text = env.channel("moneyLogChannelId").sent.at(-1).content;
  assert.match(text, /thanh toán thiếu/);
  assert.match(text, /40\.000 đ trên 100\.000 đ/);
  assert.match(text, /thủ công/);
});

// ---------------------------------------------------------------- errors shown as they are

test("every booking rule that refuses is shown to the customer in Vietnamese", async () => {
  payosOk();
  const cases = [
    [{ ...form, when: "ngày mai" }, /Không hiểu ngày giờ\. Ví dụ: 12\/10 19:30/],
    [{ ...form, duration: "lâu" }, /Không hiểu thời lượng\. Ví dụ: 1, 1\.5 hoặc 90p/],
    [{ ...form, when: "05/10 09:00" }, /Giờ hẹn đã qua/],
    [{ ...form, when: "05/10 10:30" }, /Cần đặt trước ít nhất 60 phút/],
    [{ ...form, when: "05/10 19:15" }, /Giờ bắt đầu phải tròn 30 phút/],
    [{ ...form, when: "30/11 19:00" }, /Chỉ được đặt trước tối đa 30 ngày/],
    [{ ...form, game: "Valorant" }, /không chơi game bạn chọn/],
    [{ ...form, duration: "5" }, /Thời lượng tối đa là 4 giờ/],
    [{ ...form, duration: "45p" }, /bội số của 30 phút/],
  ];
  for (const [fields, pattern] of cases) {
    resetLimits();
    const i = await order(IDS.cust, fields);
    assert.match(textOf(i), pattern);
  }
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);
});

test("outside the player's hours, a busy player, a busy customer and the limit of active bookings", async () => {
  payosOk();
  makePlayer(IDS.player2, { availability: "T2 19:00-21:00" });
  env.guild.addMember({ id: IDS.player2 });
  assert.match(textOf(await order(IDS.cust, { ...form, when: "05/10 12:00" }, IDS.player2)), /ngoài lịch rảnh của player/);

  await order(IDS.cust);
  assert.match(textOf(await order(IDS.cust2)), /Player đã có lịch khác/);
  assert.match(textOf(await order(IDS.cust, { ...form, game: "LoL" }, IDS.player2)), /Bạn đã có lịch khác trùng/);

  saveSettings({ ...getSettings(), maxActiveBookings: 1 });
  assert.match(textOf(await order(IDS.cust, { ...form, when: "06/10 19:00" })), /Bạn đang có 1 lịch chưa hoàn tất/);
});

test("the customer needs the 18+ confirmation, cannot book themselves, a paused player or one without hours", async () => {
  const stranger = await env.click(IDS.rando, `pl:book:${IDS.player}`);
  assert.equal(modalOf(stranger), undefined);
  assert.match(textOf(stranger), /xác nhận mình đủ 18 tuổi/);
  assert.match(textOf(await order(IDS.rando)), /xác nhận mình đủ 18 tuổi/);

  assert.match(textOf(await env.click(IDS.player, `pl:book:${IDS.player}`)), /không thể tự đặt lịch/);

  makePlayer(IDS.player2, { status: "PAUSED" });
  assert.match(textOf(await env.click(IDS.cust, `pl:book:${IDS.player2}`)), /không nhận lịch/);
  makePlayer("900000000000000008", { availability: "T2 19:00-20:00" });
  getDb().prepare("DELETE FROM availability WHERE player_id = ?").run("900000000000000008");
  assert.match(textOf(await env.click(IDS.cust, "pl:book:900000000000000008")), /chưa nhập lịch rảnh/);
  assert.match(textOf(await env.click(IDS.cust, "pl:book:900000000000000099")), /Không tìm thấy player/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);
});

test("a blacklisted customer is refused at every step", async () => {
  const { addToBlacklist } = await import("../src/domain/strikes.js");
  addToBlacklist(IDS.cust, "spam", IDS.owner, NOW);
  assert.match(textOf(await env.click(IDS.cust, `pl:book:${IDS.player}`)), /không được phép/);
  assert.match(textOf(await order()), /không được phép/);
  assert.match(textOf(await env.command(IDS.cust, "lichcuatoi")), /không được phép/);
});

test("booking attempts are rate limited", async () => {
  payosOk();
  let last;
  for (let n = 0; n < 7; n += 1) last = await order(IDS.cust, { ...form, when: "05/10 09:00" });
  assert.match(textOf(last), /đặt lịch quá nhiều lần/);
});

test("when payOS is down the booking is cancelled, the order closed, the customer asked to retry and nothing stays held", async () => {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  const i = await silently(() => order());
  assert.match(textOf(i), /Hệ thống thanh toán đang bận, bạn thử lại sau ít phút nhé\./);
  assert.equal(getBooking(1).status, "CANCELLED");
  assert.equal(getBooking(1).cancelled_by, "system");
  assert.equal(getOrder(getBooking(1).order_code).status, "FAILED");
  assert.equal(ledgerRows(1).length, 0);
  // the slot is free again
  payosOk();
  assert.match(textOf(await order(IDS.cust2)), /chờ thanh toán/);
});

test("when payOS is not configured the booking is not left waiting", async () => {
  const saved = { ...config.payos };
  Object.assign(config.payos, { clientId: null, apiKey: null, checksumKey: null });
  try {
    const i = await silently(() => order());
    assert.match(textOf(i), /đang bận/);
    assert.equal(getBooking(1).status, "CANCELLED");
  } finally {
    Object.assign(config.payos, saved);
  }
});

// ---------------------------------------------------------------- picking a player

test("/datlich with a player opens the form (the game can be prefilled); without one it shows a menu of bookable players", async () => {
  const withPlayer = await env.command(IDS.cust, "datlich", { opts: { player: { id: IDS.player }, game: "LoL" } });
  const fields = modalOf(withPlayer).toJSON().components.map((r) => r.components[0]);
  assert.equal(fields[0].value, "LoL");

  const menu = await env.command(IDS.cust, "datlich");
  const select = lastPayload(menu).components[0].toJSON().components[0];
  assert.equal(select.custom_id, "bk:pickplayer");
  assert.deepEqual(select.options.map((o) => o.value), [IDS.player]);

  const picked = await env.pick(IDS.cust, "bk:pickplayer", [IDS.player]);
  assert.equal(modalOf(picked).toJSON().custom_id, `bk:new:${IDS.player}`);

  const button = await env.click(IDS.cust, "bk:pick");
  assert.equal(lastPayload(button).components[0].toJSON().components[0].custom_id, "bk:pickplayer");

  const auto = await env.autocomplete(IDS.cust, "datlich", { focused: "liên", opts: { player: { id: IDS.player } } });
  assert.deepEqual(auto.out[0].choices, [{ name: "Liên Quân", value: "Liên Quân" }]);
});

test("the menu says so when nobody can be booked", async () => {
  getDb().prepare("DELETE FROM availability").run();
  assert.match(textOf(await env.command(IDS.cust, "datlich")), /chưa có player nào nhận lịch/);
});

// ---------------------------------------------------------------- cancelling

test("a customer's cancellation shows the tier before confirming, then writes the refund and tells the player", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  const ask = await env.click(IDS.cust, `bk:cancel:${b.id}`);
  assert.match(textOf(ask), /Nếu huỷ bây giờ bạn được hoàn 50% \(50\.000 đ\)\. Khoản hoàn được ghi nhận, chủ server sẽ chuyển lại cho bạn\./);
  assert.deepEqual(buttonIds(lastPayload(ask)), [`bk:cancel:yes:${b.id}`]);
  assert.equal(getBooking(b.id).status, "CONFIRMED", "asking changes nothing");

  const yes = await env.click(IDS.cust, `bk:cancel:yes:${b.id}`);
  assert.match(textOf(yes), /Đã huỷ lịch #1\. Khoản hoàn 50\.000 đ đã được ghi nhận/);
  assert.equal(getBooking(b.id).status, "CANCELLED");
  assert.equal(ledgerRows(b.id).find((r) => r.kind === "REFUND").amount_vnd, 50_000);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
  assert.match(dms(env.client, IDS.player).join("\n"), /Lịch #1 đã bị huỷ bởi khách/);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Huỷ lịch #1 bởi khách: hoàn 50\.000 đ, giữ 50\.000 đ/);

  const twice = await env.click(IDS.cust, `bk:cancel:yes:${b.id}`);
  assert.match(textOf(twice), /không thể thực hiện/);
});

test("each tier: more than 24 hours refunds all, under 2 hours refunds nothing and says so", async () => {
  const far = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 3 * DAY });
  assert.match(textOf(await env.click(IDS.cust, `bk:cancel:${far.id}`)), /hoàn 100% \(100\.000 đ\)/);
  const near = confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: NOW + 3 * HOUR });
  setClock(() => NOW + 2 * HOUR);
  assert.match(textOf(await env.click(IDS.cust2, `bk:cancel:${near.id}`)), /hoàn 0% \(0 đ\)/);
  const done = await env.click(IDS.cust2, `bk:cancel:yes:${near.id}`);
  assert.match(textOf(done), /không được hoàn tiền theo chính sách huỷ/);
  assert.equal(ledgerRows(near.id).some((r) => r.kind === "REFUND"), false);
});

test("an unpaid booking cancels without money", async () => {
  const b = book({ customerId: IDS.cust, playerId: IDS.player });
  assert.match(textOf(await env.click(IDS.cust, `bk:cancel:${b.id}`)), /chưa thanh toán nên huỷ không mất phí/);
  assert.match(textOf(await env.click(IDS.cust, `bk:cancel:yes:${b.id}`)), /Đã huỷ lịch #1\./);
  assert.equal(ledgerRows(b.id).length, 0);
  assert.equal(env.channel("moneyLogChannelId").sent.length, 0);
});

test("a player's cancellation warns about the strike, refunds the customer in full and tells them", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  assert.match(textOf(await env.click(IDS.player, `bk:cancel:${b.id}`)), /Huỷ lịch sẽ hoàn 100% cho khách và bạn bị 1 cảnh cáo\./);
  const yes = await env.click(IDS.player, `bk:cancel:yes:${b.id}`);
  assert.match(textOf(yes), /Khách được hoàn 100%\. Bạn bị 1 cảnh cáo\./);
  assert.equal(listStrikes(IDS.player).length, 1);
  assert.match(dms(env.client, IDS.cust).join("\n"), /Lịch #1 với Player 900000000000000005 đã bị huỷ\. Khoản hoàn 100\.000 đ đã được ghi nhận, chủ server sẽ chuyển lại cho bạn\./);
});

test("the third strike suspends the player, removes the role, shows the card as suspended and offers staff the cancel button", async () => {
  const memberRole = env.role("playerRoleId");
  env.guild.members.cache.get(IDS.player).roles.cache.set(memberRole, { id: memberRole });
  for (const hours of [9, 12, 15]) {
    const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + hours * HOUR });
    // a different customer id per booking is not needed: the three do not overlap
    await env.click(IDS.player, `bk:cancel:yes:${b.id}`);
  }
  assert.equal(getPlayer(IDS.player).status, "SUSPENDED");
  assert.equal(env.guild.members.cache.get(IDS.player).roles.cache.has(memberRole), false);
  const card = env.channel("playersChannelId").sent[0];
  assert.match(card.embeds[0].footer.text, /Tạm khoá/);
  const log = env.channel("bookingsLogChannelId").sent.find((m) => /bị tạm khoá do 3 cảnh cáo/.test(m.content ?? ""));
  assert.ok(log);
  assert.deepEqual(buttonIds({ components: log.components }), [`dp:cancelupcoming:${IDS.player}`]);
});

test("nobody else can cancel, ask about, or confirm the cancellation of a booking", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  for (const id of [`bk:cancel:${b.id}`, `bk:cancel:yes:${b.id}`]) {
    const i = await env.click(IDS.cust2, id);
    assert.match(textOf(i), /không có quyền thực hiện thao tác này với lịch này/);
  }
  assert.equal(getBooking(b.id).status, "CONFIRMED");
  assert.match(textOf(await env.click(IDS.cust, "bk:cancel:999")), /Không tìm thấy lịch/);
});

test("after the start plus grace the customer is refused and staff can still cancel with a full refund", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 3 * HOUR });
  setClock(() => NOW + 3 * HOUR + 16 * MIN);
  assert.match(textOf(await env.click(IDS.cust, `bk:cancel:yes:${b.id}`)), /quá thời hạn/);
  const staff = await env.click(IDS.staff, `bk:cancel:yes:${b.id}`);
  assert.match(textOf(staff), /Đã huỷ lịch #1/);
  assert.equal(ledgerRows(b.id).find((r) => r.kind === "REFUND").amount_vnd, 100_000);
});

// ---------------------------------------------------------------- listing

test("/lichcuatoi lists both sides privately and offers cancel buttons only where cancelling is possible", async () => {
  const open = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  const done = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 12 * HOUR });
  setClock(() => NOW + 12 * HOUR + 30 * MIN);
  getDb().prepare("UPDATE bookings SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?").run(NOW + 12 * HOUR, done.id);
  setClock(() => NOW + 14 * HOUR);
  complete(done.id, SYSTEM, NOW + 14 * HOUR);
  setClock(() => NOW);
  const i = await env.command(IDS.cust, "lichcuatoi");
  const text = textOf(i);
  assert.match(text, /Khách \| Player 900000000000000005 \| #1 \| T2 05\/10 19:00 \| 1 giờ \| 100\.000 đ \| Đã xác nhận/);
  assert.match(text, /Hoàn thành/);
  assert.deepEqual(buttonIds(lastPayload(i)), [`bk:cancel:${open.id}`, `bk:again:${done.id}`], "cancel only where possible, and book again with the player of a finished session");
  assert.match(textOf(await env.command(IDS.cust2, "lichcuatoi")), /chưa có lịch nào/);
  const asPlayer = await env.command(IDS.player, "lichcuatoi");
  assert.match(textOf(asPlayer), /Player \| <@900000000000000003>/);
});

// ---------------------------------------------------------------- rating

async function completed() {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 3 * HOUR });
  getDb().prepare("UPDATE bookings SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?").run(NOW + 3 * HOUR, b.id);
  complete(b.id, SYSTEM, NOW + 4 * HOUR);
  setClock(() => NOW + 4 * HOUR + MIN);
  return b;
}

test("rating: only the customer, a modal with an optional review, the review is cleaned and posted, the card is refreshed, once only", async () => {
  const b = await completed();
  const open = await env.click(IDS.cust, `bk:rate:${b.id}:5`);
  assert.equal(modalOf(open).toJSON().custom_id, `bk:rate:submit:${b.id}:5`);
  assert.equal(modalOf(open).toJSON().components[0].components[0].required, false);
  assert.match(textOf(await env.click(IDS.cust2, `bk:rate:${b.id}:5`)), /không có quyền thực hiện thao tác này với lịch này/);
  assert.match(textOf(await env.click(IDS.cust, `bk:rate:${b.id}:9`)), /từ 1 đến 5/);

  const submitted = await env.submit(IDS.cust, `bk:rate:submit:${b.id}:5`, { review: "Rất vui @everyone http://spam.example" });
  assert.match(textOf(submitted), /Cảm ơn bạn đã đánh giá!/);
  assert.equal(getBooking(b.id).rating, 5);
  const posted = env.channel("feedbackChannelId").sent[0].embeds[0];
  assert.match(posted.title, /★★★★★ cho Player 9000/);
  assert.equal(posted.description, "Rất vui");
  assert.ok(!JSON.stringify(posted).includes("spam.example"));
  assert.ok(!JSON.stringify(posted).includes(IDS.cust), "the customer is not named in the public review");
  const card = env.channel("playersChannelId").sent[0];
  assert.ok(card.embeds[0].fields.some((f) => f.name === "Đánh giá" && /5 sao \(1 lượt\)/.test(f.value)));

  assert.match(textOf(await env.submit(IDS.cust, `bk:rate:submit:${b.id}:4`, { review: "" })), /đã được đánh giá rồi/);
  assert.equal(getPlayer(IDS.player).ratingCount, 1);
});

test("a rating after the review window is refused, and one for a booking that was not completed", async () => {
  const b = await completed();
  setClock(() => NOW + 4 * HOUR + 25 * HOUR);
  assert.match(textOf(await env.submit(IDS.cust, `bk:rate:submit:${b.id}:3`, { review: "" })), /Đã hết thời hạn đánh giá/);
  const open = confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  assert.match(textOf(await env.submit(IDS.cust2, `bk:rate:submit:${open.id}:3`, { review: "" })), /Chỉ đánh giá được lịch đã hoàn thành/);
  assert.ok(hasAttested(IDS.cust));
  assert.ok(vn);
});

// ---------------------------------------------------------------- buttons that live in DMs

test("the rating, problem and cancel buttons in a DM work without a guild, and nothing else is accepted there", async () => {
  const b = await completed();
  const open = await env.dmClick(IDS.cust, `bk:rate:${b.id}:4`);
  assert.equal(modalOf(open).toJSON().custom_id, `bk:rate:submit:${b.id}:4`);
  const done = await env.dmSubmit(IDS.cust, `bk:rate:submit:${b.id}:4`, { review: "Ổn" });
  assert.match(textOf(done), /Cảm ơn bạn đã đánh giá!/);
  assert.equal(getBooking(b.id).rating, 4);
  assert.match(env.channel("feedbackChannelId").sent[0].embeds[0].title, /★★★★☆/);

  assert.match(textOf(await env.dmClick(IDS.cust2, `bk:rate:${b.id}:5`)), /không có quyền thực hiện thao tác này với lịch này/);

  const problem = await env.dmClick(IDS.cust, `bk:problem:${b.id}`);
  assert.equal(modalOf(problem).toJSON().custom_id, `bk:problem:submit:${b.id}`);
  const filed = await env.dmSubmit(IDS.cust, `bk:problem:submit:${b.id}`, { reason: "Player không nói chuyện" });
  assert.match(textOf(filed), /Đã gửi báo cáo/);
  assert.equal(env.channel("disputesChannelId").sent.length, 1);

  const other = confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  assert.match(textOf(await env.dmClick(IDS.cust2, `bk:cancel:${other.id}`)), /hoàn 50%/);
  assert.match(textOf(await env.dmClick(IDS.cust2, `bk:cancel:yes:${other.id}`)), /Đã huỷ lịch/);
  assert.equal(getBooking(other.id).status, "CANCELLED");

  for (const id of ["mn:paid:yes:1", "pl:approve:900000000000000005", "dp:resolve:1:pay_player", "age:open", "bk:pick"]) {
    assert.equal((await env.dmClick(IDS.owner, id)).out.length, 0, `${id} is ignored in a DM`);
  }
});
