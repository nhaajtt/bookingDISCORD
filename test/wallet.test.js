import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, getDb, getSettings, saveSettings } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, buttonIds, lastPayload } from "./discord-fakes.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { checkPayments } from "../src/jobs/payments.js";
import { cancel, complete, start, SYSTEM, getBooking, actorFor, createBooking } from "../src/domain/bookings.js";
import { pendingRefunds, pendingPayouts, checkBookingLedger } from "../src/domain/ledger.js";
import { creditTopup, walletBalance, walletHistory, payFromWallet, adjustWallet, loyaltyPoints, redeemPoints, walletLiability, bonusGiven, bonusFor, packageFor, payExtensionFromWallet } from "../src/domain/wallet.js";
import { quoteExtension, applyExtension } from "../src/domain/extensions.js";
import { ownerSummary } from "../src/domain/summary.js";
import { getOrder, pendingExtensions } from "../src/pay/orders.js";
import { getPlayer } from "../src/domain/players.js";

let env;
let calls;
beforeEach(async () => {
  env = await boot();
  calls = [];
  makePlayer(IDS.player, { rateVnd: 100_000 });
  makeCustomer(IDS.cust);
  makeCustomer(IDS.cust2);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
});
afterEach(() => {
  globalThis.fetch = undefined;
  setClock(() => NOW);
});

const gateway = (status = "PENDING", amount = 100_000) => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const body = String(url).endsWith("/v2/payment-requests")
      ? { code: "00", data: { checkoutUrl: "https://pay.payos.vn/web/abc", paymentLinkId: "abc" } }
      : { code: "00", data: { status, amount, amountPaid: status === "PAID" ? amount : 0 } };
    return { ok: true, status: 200, json: async () => body };
  };
};
const form = { game: "liên quân", when: "05/10 19:00", duration: "1" };
const fund = (userId, vnd) => creditTopup(Math.floor(Math.random() * 1e9), userId, vnd, 0, NOW);
const START = NOW + 9 * HOUR;

// ---------------------------------------------------------------- the wallet itself

test("the balance is the sum of the rows, and a top-up is credited once however often it is confirmed", () => {
  assert.equal(walletBalance(IDS.cust), 0);
  assert.equal(creditTopup(777, IDS.cust, 500_000, 25_000, NOW).created, true);
  assert.equal(creditTopup(777, IDS.cust, 500_000, 25_000, NOW + 1).created, false);
  assert.equal(walletBalance(IDS.cust), 525_000);
  assert.deepEqual(walletHistory(IDS.cust).map((h) => [h.kind, h.amount_vnd]).sort(), [["BONUS", 25_000], ["TOPUP", 500_000]]);
  assert.equal(bonusGiven(), 25_000);
  assert.deepEqual(walletLiability(), { vnd: 525_000, people: 1 });
  assert.equal(bonusFor(500_000, 5), 25_000);
  assert.equal(bonusFor(333_000, 5), 16_650);
  assert.equal(packageFor(500_000).bonusPercent, 5);
  assert.throws(() => packageFor(123_000), /không còn nữa/);
});

test("paying from the wallet confirms the booking, books one spend, and refuses a low balance, another person and a second payment", () => {
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  assert.throws(() => payFromWallet(b.id, IDS.cust, NOW), /còn 0 đ, không đủ/);
  fund(IDS.cust, 150_000);
  assert.throws(() => payFromWallet(b.id, IDS.cust2, NOW), /không có quyền/);
  const done = payFromWallet(b.id, IDS.cust, NOW);
  assert.equal(done.balance, 50_000);
  assert.equal(getBooking(b.id).status, "CONFIRMED");
  assert.equal(getBooking(b.id).paid_with, "WALLET");
  assert.throws(() => payFromWallet(b.id, IDS.cust, NOW), /không thể thực hiện thao tác/);
  assert.equal(walletBalance(IDS.cust), 50_000, "nothing was taken twice");
});

test("a booking cannot be paid from the wallet while a payment link is open for it", async () => {
  gateway();
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  const { createBookingOrder } = await import("../src/pay/orders.js");
  createBookingOrder(b.id, NOW);
  fund(IDS.cust, 500_000);
  assert.throws(() => payFromWallet(b.id, IDS.cust, NOW), /link thanh toán đang chờ/);
});

test("the owner can correct a wallet by hand but never below zero, and must say why", () => {
  assert.equal(adjustWallet(IDS.cust, 50_000, "tặng khách quen", NOW), 50_000);
  assert.equal(adjustWallet(IDS.cust, -20_000, "sửa nhầm", NOW), 30_000);
  assert.throws(() => adjustWallet(IDS.cust, -40_000, "quá tay", NOW), /không thể âm/);
  assert.throws(() => adjustWallet(IDS.cust, 0, "x", NOW), /khác 0/);
  assert.throws(() => adjustWallet(IDS.cust, 5_000, "  ", NOW), /lý do/);
  assert.equal(walletBalance(IDS.cust), 30_000);
});

// ---------------------------------------------------------------- refunds go back into the wallet

test("cancelling a wallet-paid booking refunds the wallet at once and leaves nothing for the owner to transfer", () => {
  fund(IDS.cust, 300_000);
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 30 * HOUR });
  payFromWallet(b.id, IDS.cust, NOW);
  const result = cancel(b.id, actorFor(getBooking(b.id), IDS.cust), NOW + MIN);
  assert.equal(result.refundVnd, 100_000);
  assert.equal(walletBalance(IDS.cust), 300_000);
  const refund = ledgerRows(b.id).find((r) => r.kind === "REFUND");
  assert.deepEqual([refund.status, refund.paid_by], ["PAID", "wallet"]);
  assert.equal(pendingRefunds().length, 0);
  assert.equal(checkBookingLedger(b.id, 100_000).ok, true);
  assert.equal(walletHistory(IDS.cust).filter((h) => h.kind === "REFUND").length, 1);
});

test("a late customer cancellation refunds only part to the wallet and the rest is kept as usual", () => {
  fund(IDS.cust, 300_000);
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 5 * HOUR });
  payFromWallet(b.id, IDS.cust, NOW);
  const result = cancel(b.id, actorFor(getBooking(b.id), IDS.cust), NOW + MIN);
  assert.equal(result.refundVnd, 50_000);
  assert.equal(walletBalance(IDS.cust), 250_000);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
  assert.equal(pendingPayouts(NOW + 30 * DAY).length, 1, "the player's kept share is still owed");
});

test("a booking paid by link is still refunded to the owner's queue, not to the wallet", () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 30 * HOUR });
  cancel(b.id, actorFor(getBooking(b.id), IDS.cust), NOW + MIN);
  assert.equal(pendingRefunds().length, 1);
  assert.equal(walletBalance(IDS.cust), 0);
});

test("a completed wallet-paid booking pays the player exactly like any other", () => {
  fund(IDS.cust, 200_000);
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR });
  payFromWallet(b.id, IDS.cust, NOW);
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  complete(b.id, SYSTEM, NOW + 3 * HOUR);
  const rows = ledgerRows(b.id);
  assert.equal(rows.find((r) => r.kind === "PLAYER_PAYOUT").amount_vnd, 90_000);
  assert.equal(rows.find((r) => r.kind === "FEE_INCOME").amount_vnd, 10_000);
  assert.equal(walletBalance(IDS.cust), 100_000);
});

// ---------------------------------------------------------------- in Discord

test("/vi xem shows the balance, the points and the history; strangers need the 18+ confirmation", async () => {
  fund(IDS.cust, 250_000);
  const text = textOf(await env.command(IDS.cust, "vi", { subcommand: "xem" }));
  assert.match(text, /Số dư: 250\.000 đ/);
  assert.match(text, /Nạp ví \| \+250\.000 đ/);
  assert.match(textOf(await env.command(IDS.rando, "vi", { subcommand: "xem" })), /18 tuổi/);
});

test("/vi nap lists the packages, the button makes a top-up link, and the confirmed payment credits the wallet and the bonus once", async () => {
  gateway();
  const list = await env.command(IDS.cust, "vi", { subcommand: "nap" });
  assert.match(textOf(list), /Nạp 500\.000 đ: nhận 525\.000 đ \(tặng thêm 5%\)/);
  assert.deepEqual(buttonIds(lastPayload(list)), ["wl:topup:500000", "wl:topup:1000000", "wl:topup:2000000"]);
  const pressed = await env.click(IDS.cust, "wl:topup:500000");
  const link = lastPayload(pressed).components[0].toJSON().components[0].url;
  assert.equal(link, "https://pay.payos.vn/web/abc");
  const order = getDb().prepare("SELECT * FROM orders").get();
  assert.deepEqual([order.kind, order.booking_id, order.amount, order.bonus_vnd, order.provider], ["TOPUP", 0, 500_000, 25_000, "payos"]);
  const sent = calls.find((c) => c.body?.orderCode);
  assert.match(sent.body.description, /^NAP\d{6}$/);
  assert.equal(sent.body.amount, 500_000);

  gateway("PAID", 500_000);
  const events = [];
  const client = { notifyBooking: async (e) => events.push(e) };
  assert.deepEqual(await checkPayments(env.client, NOW + MIN), { checked: 1, paid: 1, late: 0 });
  assert.equal(walletBalance(IDS.cust), 525_000);
  assert.match(dms(env.client, IDS.cust).at(-1), /Đã nạp 500\.000 đ vào ví và được tặng thêm 25\.000 đ\. Số dư hiện tại: 525\.000 đ/);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Nạp ví 500\.000 đ \(tặng thêm 25\.000 đ\)/);
  assert.deepEqual(await checkPayments(client, NOW + 2 * MIN), { checked: 0, paid: 0, late: 0 });
  assert.equal(walletBalance(IDS.cust), 525_000);
  assert.equal(getOrder(order.order_code).status, "PAID");
});

test("a top-up link that closes after part of the money arrived is reported, not credited", async () => {
  gateway();
  await env.click(IDS.cust, "wl:topup:500000");
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: "00", data: { status: "CANCELLED", amount: 500_000, amountPaid: 200_000 } }) });
  await checkPayments(env.client, NOW + MIN);
  assert.equal(walletBalance(IDS.cust), 0);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /đơn nạp ví/);
});

test("a package that was removed cannot be bought from an old button, and a gateway failure is answered politely", async () => {
  assert.match(textOf(await env.click(IDS.cust, "wl:topup:123000")), /không còn nữa/);
  globalThis.fetch = async () => {
    throw new Error("payOS down");
  };
  const original = console.error;
  console.error = () => {};
  try {
    assert.match(textOf(await env.click(IDS.cust, "wl:topup:500000")), /đang bận/);
  } finally {
    console.error = original;
  }
  assert.equal(getDb().prepare("SELECT status FROM orders").get().status, "FAILED");
});

test("a customer with enough in the wallet is offered the wallet or a link, and the link is only made when asked for", async () => {
  gateway();
  fund(IDS.cust, 300_000);
  const i = await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  assert.deepEqual(buttonIds(lastPayload(i)), ["bk:wallet:1", "bk:paylink:1", "bk:cancel:1"]);
  assert.match(textOf(i), /Ví của bạn còn 300\.000 đ/);
  assert.equal(calls.length, 0, "no payment link was made yet");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM orders").get().n, 0);

  const paid = await env.click(IDS.cust, "bk:wallet:1");
  assert.match(textOf(paid), /Đã thanh toán lịch #1 bằng ví\. Ví còn 200\.000 đ/);
  assert.equal(getBooking(1).status, "CONFIRMED");
  assert.match(dms(env.client, IDS.cust).at(-1), /Đã thanh toán bằng ví\. Lịch #1/);
  assert.match(dms(env.client, IDS.player).at(-1), /Bạn có lịch mới/);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /thanh toán bằng ví: 100\.000 đ/);
  assert.match(textOf(await env.click(IDS.cust, "bk:wallet:1")), /không thể thực hiện thao tác/);
  assert.match(textOf(await env.click(IDS.cust2, "bk:wallet:1")), /không có quyền/);
});

test("choosing the link instead of the wallet makes the order, and then the wallet button no longer works for that booking", async () => {
  gateway();
  fund(IDS.cust, 300_000);
  await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  const linked = await env.click(IDS.cust, "bk:paylink:1");
  assert.equal(lastPayload(linked).components[0].toJSON().components[0].url, "https://pay.payos.vn/web/abc");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1);
  const again = await env.click(IDS.cust, "bk:paylink:1");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM orders").get().n, 1, "the same link is shown again, not a second order");
  assert.ok(lastPayload(again).embeds);
  assert.match(textOf(await env.click(IDS.cust, "bk:wallet:1")), /link thanh toán đang chờ/);
  assert.equal(walletBalance(IDS.cust), 300_000);
  assert.match(textOf(await env.click(IDS.cust2, "bk:paylink:1")), /không có quyền/);
});

test("with too little in the wallet the booking goes straight to a payment link as before", async () => {
  gateway();
  fund(IDS.cust, 50_000);
  const i = await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  assert.equal(lastPayload(i).components[0].toJSON().components[0].url, "https://pay.payos.vn/web/abc");
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- points

test("a point is earned for every 1.000 dong spent on completed sessions and can be turned into wallet credit", async () => {
  assert.deepEqual(loyaltyPoints(IDS.cust), { enabled: true, earned: 0, redeemed: 0, available: 0, pointValueVnd: 50, minRedeem: 100 });
  for (const hours of [2, 4]) {
    const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + hours * HOUR });
    start(b.id, SYSTEM, NOW + hours * HOUR);
    complete(b.id, SYSTEM, NOW + (hours + 1) * HOUR);
  }
  assert.equal(loyaltyPoints(IDS.cust).earned, 200);
  assert.throws(() => redeemPoints(IDS.cust, 50, NOW), /tối thiểu 100 điểm/);
  assert.throws(() => redeemPoints(IDS.cust, 300, NOW), /chỉ có 200 điểm/);
  const done = redeemPoints(IDS.cust, 120, NOW);
  assert.deepEqual([done.creditVnd, done.balance], [6_000, 6_000]);
  assert.equal(loyaltyPoints(IDS.cust).available, 80);
  const chat = await env.command(IDS.cust, "vi", { subcommand: "doi-diem", opts: { "so-diem": 80 } });
  assert.match(textOf(chat), /tối thiểu 100 điểm/);
  saveSettings({ ...getSettings(), loyalty: { ...getSettings().loyalty, minRedeem: 10 } });
  assert.match(textOf(await env.command(IDS.cust, "vi", { subcommand: "doi-diem", opts: { "so-diem": 80 } })), /Đã đổi 80 điểm thành 4\.000 đ\. Ví còn 10\.000 đ/);
  saveSettings({ ...getSettings(), loyalty: { ...getSettings().loyalty, earnPerVnd: 0 } });
  assert.equal(loyaltyPoints(IDS.cust).enabled, false);
});

test("the owner's summary shows how much service is owed through wallets and what the bonuses cost", async () => {
  creditTopup(1, IDS.cust, 500_000, 25_000, NOW);
  const s = ownerSummary(NOW);
  assert.deepEqual(s.wallet, { liabilityVnd: 525_000, people: 1, bonusGivenVnd: 25_000 });
  const staff = await env.command(IDS.staff, "staff", { subcommand: "tong-ket" });
  assert.match(textOf(staff), /Ví khách: Còn nợ dịch vụ: 525\.000 đ \(1 người\), đã tặng thêm khi nạp: 25\.000 đ/);
});

test("/admin dieu-chinh-vi is for owners and is written to the audit log", async () => {
  assert.match(textOf(await env.command(IDS.staff, "admin", { subcommand: "dieu-chinh-vi", opts: { user: { id: IDS.cust }, "so-tien": 10_000, "ly-do": "x" } })), /không có quyền/);
  const ok = await env.command(IDS.owner, "admin", { subcommand: "dieu-chinh-vi", opts: { user: { id: IDS.cust }, "so-tien": 40_000, "ly-do": "quà tặng" } });
  assert.match(textOf(ok), /\+40\.000 đ\. Số dư mới: 40\.000 đ/);
  assert.equal(walletBalance(IDS.cust), 40_000);
  const bad = await env.command(IDS.owner, "admin", { subcommand: "dieu-chinh-vi", opts: { user: { id: IDS.cust }, "so-tien": -90_000, "ly-do": "quá" } });
  assert.match(textOf(bad), /không thể âm/);
});

// ---------------------------------------------------------------- extending a running session

function running(extra = {}) {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR, ...extra });
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  return b;
}
const T = NOW + 2 * HOUR + 30 * MIN;

test("an extension is quoted at the player's rate for the minutes after the session, and only while it runs", () => {
  const b = running();
  const q = quoteExtension(b.id, 60, T);
  assert.deepEqual([q.priceVnd, q.feeVnd, q.newEndAt], [100_000, 10_000, NOW + 4 * HOUR]);
  assert.equal(quoteExtension(b.id, 30, T).priceVnd, 50_000);
  assert.throws(() => quoteExtension(b.id, 45, T), /bội số của 30/);
  assert.throws(() => quoteExtension(b.id, 150, T), /tối đa 120 phút/);
  assert.throws(() => quoteExtension(b.id, 60, NOW + 3 * HOUR), /đã hết giờ/);
  const waiting = confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: NOW + 6 * HOUR });
  assert.throws(() => quoteExtension(waiting.id, 30, T), /đang diễn ra/);
  saveSettings({ ...getSettings(), maxExtendMin: 0 });
  assert.throws(() => quoteExtension(b.id, 30, T), /đang tắt/);
});

test("an extension is refused when the player has another booking right after, or is not free then", () => {
  const b = running();
  confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: NOW + 3 * HOUR + 30 * MIN });
  assert.equal(quoteExtension(b.id, 30, T).priceVnd, 50_000, "the half hour before the next booking is free");
  assert.throws(() => quoteExtension(b.id, 60, T), /Player có lịch khác ngay sau/);
});

test("a paid extension makes the same booking longer and dearer, and the ledger follows", () => {
  const b = running();
  const q = quoteExtension(b.id, 60, T);
  const longer = applyExtension(b.id, 60, q.priceVnd, q.feeVnd, T);
  assert.deepEqual([longer.duration_min, longer.price_vnd, longer.fee_vnd, longer.extended_min, longer.list_price_vnd], [120, 200_000, 20_000, 60, 200_000]);
  assert.throws(() => quoteExtension(b.id, 90, T), /tối đa 120 phút \(đã thêm 60 phút\)/);
  complete(b.id, SYSTEM, NOW + 4 * HOUR);
  const rows = ledgerRows(b.id);
  assert.equal(sum(rows), 200_000);
  assert.equal(rows.find((r) => r.kind === "PLAYER_PAYOUT").amount_vnd, 180_000);
  assert.throws(() => applyExtension(b.id, 30, 50_000, 5_000, NOW + 5 * HOUR), /không còn gia hạn/);
});

test("a session paid from the wallet is extended from the wallet at once", () => {
  fund(IDS.cust, 400_000);
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR });
  payFromWallet(b.id, IDS.cust, NOW);
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  const done = payExtensionFromWallet(b.id, IDS.cust, 60, T);
  assert.deepEqual([done.priceVnd, done.balance, done.booking.duration_min], [100_000, 200_000, 120]);
  assert.throws(() => payExtensionFromWallet(b.id, IDS.cust2, 30, T), /không có quyền/);
  adjustWallet(IDS.cust, -200_000, "dùng hết", T);
  assert.throws(() => payExtensionFromWallet(b.id, IDS.cust, 30, T), /không đủ/);
  assert.equal(getBooking(b.id).duration_min, 120, "a failed payment leaves the session as it was");
  cancel(b.id, { role: "staff", userId: "s" }, T + MIN);
  assert.equal(walletBalance(IDS.cust), 200_000 - 200_000 + 200_000, "the whole price, extension included, goes back to the wallet");
});

test("the room button offers the options that fit, and a customer on a link gets a payment link that holds the minutes", async () => {
  gateway();
  const b = running();
  confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: NOW + 4 * HOUR });
  setClock(() => T);
  const offer = await env.click(IDS.cust, `bk:extend:${b.id}`);
  const menu = lastPayload(offer).components[0].toJSON().components[0];
  assert.equal(menu.custom_id, `bk:extendpick:${b.id}`);
  assert.deepEqual(menu.options.map((o) => o.value), ["30", "60"], "the player's next booking limits it to an hour");
  assert.match(menu.options[0].label, /Thêm 0,5 giờ: 50\.000 đ/);
  assert.match(textOf(await env.click(IDS.cust2, `bk:extend:${b.id}`)), /Chỉ khách đặt lịch/);

  const picked = await env.pick(IDS.cust, `bk:extendpick:${b.id}`, ["60"]);
  assert.equal(lastPayload(picked).components[0].toJSON().components[0].url, "https://pay.payos.vn/web/abc");
  const order = getDb().prepare("SELECT * FROM orders WHERE kind = 'EXTEND'").get();
  assert.deepEqual([order.amount, order.extra_min, order.extra_fee, order.booking_id], [100_000, 60, 10_000, b.id]);
  assert.match(calls.find((c) => c.body?.orderCode).body.description, /^GIA\d{6}$/);
  assert.deepEqual(pendingExtensions(IDS.player, T).map((h) => h.end_at - h.start_at), [60 * MIN]);
  assert.match(textOf(await env.pick(IDS.cust, `bk:extendpick:${b.id}`, ["30"])), /link thanh toán đang chờ/);

  // somebody else cannot book those minutes while the customer is paying
  assert.throws(() => createBooking({ customerId: IDS.cust2, playerId: IDS.player, game: "LoL", startAt: NOW + 3 * HOUR + 30 * MIN, durationMin: 30 }, T), /đã có lịch khác/);

  // the payment arrives: the session is longer, the room hears about it, the player is told
  gateway("PAID", 100_000);
  await checkPayments(env.client, T + 2 * MIN);
  assert.equal(getBooking(b.id).duration_min, 120);
  assert.equal(getBooking(b.id).price_vnd, 200_000);
  const room = env.guild.channels.cache.get(getBooking(b.id).text_channel_id);
  assert.ok(!room, "this booking has no rooms in the test, so nothing was posted there");
  assert.match(dms(env.client, IDS.cust).at(-1), /gia hạn thêm 1 giờ\. Buổi hẹn #1 giờ kết thúc lúc T2 05\/10 14:00/);
  assert.match(dms(env.client, IDS.player).at(-1), /Khách đã gia hạn buổi #1 thêm 1 giờ/);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Nhận 100\.000 đ gia hạn lịch #1/);
});

test("an extension paid after the session ended is reported for a manual refund and does not change the booking", async () => {
  gateway();
  const b = running();
  setClock(() => T);
  await env.pick(IDS.cust, `bk:extendpick:${b.id}`, ["60"]);
  complete(b.id, SYSTEM, NOW + 3 * HOUR);
  gateway("PAID", 100_000);
  await checkPayments(env.client, NOW + 3 * HOUR + MIN);
  assert.equal(getBooking(b.id).duration_min, 60);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Cần hoàn tiền thủ công: lịch #1 có gia hạn đã trả tiền/);
  assert.match(dms(env.client, IDS.cust).at(-1), /không dùng được/);
});

test("the extension button needs the 18+ confirmation, a real booking, and the extension feature switched on", async () => {
  assert.match(textOf(await env.click(IDS.rando, "bk:extend:1")), /18 tuổi/);
  assert.match(textOf(await env.click(IDS.cust, "bk:extend:99")), /Không tìm thấy lịch/);
  const b = running();
  saveSettings({ ...getSettings(), maxExtendMin: 0 });
  setClock(() => T);
  assert.match(textOf(await env.click(IDS.cust, `bk:extend:${b.id}`)), /đang tắt|Không thể gia hạn/);
  assert.ok(getPlayer(IDS.player));
});
