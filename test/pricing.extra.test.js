import { NOW, HOUR, DAY, MIN, vn, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, getDb, getSettings, saveSettings } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { textOf, modalOf, lastPayload } from "./discord-fakes.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { quoteBooking, rateFor, setGameRates, parseGameRates, peakPercentAt, parsePeaks, formatPeaks, parsePackages } from "../src/domain/quoting.js";
import { createCoupon, couponDiscount, getCoupon, listCoupons, setCouponActive, couponReport, normalizeCode } from "../src/domain/coupons.js";
import { cancel, createBooking, expireUnpaid, getBooking, pay, actorFor, complete, SYSTEM } from "../src/domain/bookings.js";
import { getPlayer } from "../src/domain/players.js";
import { normalizeSettings } from "../src/settings.js";
import { parseVnd } from "../src/discord/modals.js";

let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player, { rateVnd: 100_000, games: ["Liên Quân", "LoL"] });
  makeCustomer(IDS.cust);
  makeCustomer(IDS.cust2);
  env.guild.addMember({ id: IDS.player });
  await refreshCard(env.guild, IDS.player);
});
afterEach(() => {
  globalThis.fetch = undefined;
  setClock(() => NOW);
});

const START = NOW + 9 * HOUR; // Monday 19:00
const player = () => getPlayer(IDS.player);
const peaks = (list) => saveSettings({ ...getSettings(), peaks: list });
const quote = (extra = {}) => quoteBooking({ player: player(), game: "Liên Quân", startAt: START, durationMin: 60, userId: IDS.cust, now: NOW, ...extra });

// ---------------------------------------------------------------- the quote without extras is the old price

test("with no peak window and no coupon the price is exactly rate times duration", () => {
  const q = quote();
  assert.deepEqual([q.listPriceVnd, q.surchargeVnd, q.discountVnd, q.priceVnd, q.feeVnd, q.playerShareVnd], [100_000, 0, 0, 100_000, 10_000, 90_000]);
  assert.equal(quote({ durationMin: 90 }).priceVnd, 150_000);
});

// ---------------------------------------------------------------- per-game prices

test("a per-game price replaces the base rate for that game only", () => {
  assert.equal(setGameRates(IDS.player, { "Liên Quân": 150_000 }), 1);
  assert.equal(rateFor(player(), "liên quân"), 150_000);
  assert.equal(rateFor(player(), "LoL"), 100_000);
  assert.equal(quote().priceVnd, 150_000);
  assert.equal(quote({ game: "LoL" }).priceVnd, 100_000);
  const b = book({ customerId: IDS.cust, playerId: IDS.player, game: "Liên Quân", startAt: START });
  assert.equal(b.price_vnd, 150_000);
  assert.equal(b.fee_vnd, 15_000);
  setGameRates(IDS.player, {});
  assert.equal(quote().priceVnd, 100_000, "clearing goes back to the base rate");
});

test("per-game prices are held to the owner's limits and parsed from lines", () => {
  assert.throws(() => setGameRates(IDS.player, { LoL: 1_000_000 }), /Giá theo giờ phải từ/);
  assert.throws(() => setGameRates(IDS.player, { LoL: 100_500 }), /chia hết cho/);
  const ok = parseGameRates("Liên Quân 120k\nlol 110.000", ["Liên Quân", "LoL"], parseVnd);
  assert.deepEqual(ok.rates, { "Liên Quân": 120_000, LoL: 110_000 });
  assert.match(parseGameRates("Dota 100000", ["Liên Quân"], parseVnd).error, /không nằm trong danh sách game/);
  assert.match(parseGameRates("Liên Quân nhiều", ["Liên Quân"], parseVnd).error, /chưa đúng/);
  assert.deepEqual(parseGameRates("", ["Liên Quân"], parseVnd).rates, {});
});

// ---------------------------------------------------------------- peak hours

test("only the half hours inside a peak window carry the surcharge", () => {
  peaks([{ days: [1], startMin: 19 * 60 + 30, endMin: 21 * 60, percent: 20 }]);
  assert.equal(peakPercentAt(START), 0);
  assert.equal(peakPercentAt(START + 30 * MIN), 20);
  assert.equal(peakPercentAt(START + 90 * MIN), 20);
  assert.equal(peakPercentAt(START + 120 * MIN), 0, "the window ends at 21:00");
  const q = quote({ durationMin: 90 });
  // 19:00 plain 50.000, 19:30 and 20:00 at +20% = 60.000 each
  assert.equal(q.listPriceVnd, 170_000);
  assert.equal(q.surchargeVnd, 20_000);
  assert.equal(q.feeVnd, 17_000);
  assert.equal(quote({ startAt: START - DAY }).surchargeVnd, 0, "Sunday has no window");
  assert.equal(quote({ startAt: START + 7 * DAY, durationMin: 90 }).listPriceVnd, 170_000, "the same window every Monday");
});

test("overlapping windows use the higher percent and a slot price is rounded to whole dong", () => {
  peaks([
    { days: [1], startMin: 19 * 60, endMin: 20 * 60, percent: 10 },
    { days: [1], startMin: 19 * 60, endMin: 19 * 60 + 30, percent: 35 },
  ]);
  assert.equal(peakPercentAt(START), 35);
  assert.equal(peakPercentAt(START + 30 * MIN), 10);
  const q = quoteBooking({ player: { ...player(), rateVnd: 123_000 }, game: "x", startAt: START, durationMin: 60, userId: IDS.cust });
  // 61.500 * 1.35 = 83.025 and 61.500 * 1.10 = 67.650
  assert.equal(q.listPriceVnd, 83_025 + 67_650);
  assert.equal(Number.isInteger(q.priceVnd), true);
});

test("a booking over midnight is priced slot by slot on the local clock", () => {
  peaks([{ days: [1, 2], startMin: 23 * 60 + 30, endMin: 1440, percent: 100 }, { days: [2], startMin: 0, endMin: 30, percent: 50 }]);
  const q = quote({ startAt: vn(2026, 10, 5, 23, 0), durationMin: 90 });
  assert.equal(q.listPriceVnd, 50_000 + 100_000 + 75_000);
});

test("peak windows are written and read back as text", () => {
  const parsed = parsePeaks("T6 T7 CN 19:00-23:00 +20\nT2-T5 20h-22h 10%");
  assert.deepEqual(parsed.peaks, [
    { days: [0, 5, 6], startMin: 1140, endMin: 1380, percent: 20 },
    { days: [1, 2, 3, 4], startMin: 1200, endMin: 1320, percent: 10 },
  ]);
  assert.equal(formatPeaks(parsed.peaks), "T6 T7 CN 19:00-23:00 +20\nT2 T3 T4 T5 20:00-22:00 +10");
  assert.deepEqual(parsePeaks(formatPeaks(parsed.peaks)).peaks, parsed.peaks);
  assert.deepEqual(parsePeaks("").peaks, []);
  for (const bad of ["T9 19:00-20:00 +10", "T2 19:10-20:00 +10", "T2 20:00-19:00 +10", "T2 19:00-20:00 +0", "T2 19:00-20:00 +150", "cả tuần tối nay", "T5-T2 19:00-20:00 +5"]) assert.ok(parsePeaks(bad).error, bad);
  assert.match(parsePeaks(Array.from({ length: 7 }, () => "T2 19:00-20:00 +5").join("\n")).error, /Tối đa 6/);
});

test("settings clean up peaks and packages", () => {
  const s = normalizeSettings({ peaks: [{ days: [1, 1, 9, "x"], startMin: 600, endMin: 660, percent: 20 }, { days: [], startMin: 0, endMin: 60, percent: 5 }, { days: [2], startMin: 601, endMin: 660, percent: 5 }, null], packages: [{ amountVnd: 1_500, bonusPercent: 5 }, { amountVnd: 200_000, bonusPercent: 500 }, { amountVnd: 200_400, bonusPercent: 3 }] });
  assert.deepEqual(s.peaks, [{ days: [1], startMin: 600, endMin: 660, percent: 20 }]);
  assert.deepEqual(s.packages, [{ amountVnd: 200_000, bonusPercent: 100 }]);
  assert.equal(normalizeSettings({}).packages.length, 3);
  assert.deepEqual(normalizeSettings({ packages: [] }).packages, []);
  assert.equal(normalizeSettings({}).loyalty.pointValueVnd, 50);
  assert.deepEqual(parsePackages("500k +5\n1.000.000 10%", parseVnd).packages, [{ amountVnd: 500_000, bonusPercent: 5 }, { amountVnd: 1_000_000, bonusPercent: 10 }]);
  assert.ok(parsePackages("abc", parseVnd).error);
  assert.ok(parsePackages("", parseVnd).error);
});

// ---------------------------------------------------------------- coupons

test("a percent coupon is taken from the fee only, so the player's share does not change", () => {
  createCoupon({ code: "hello10", kind: "PERCENT", value: 10 }, NOW);
  const q = quote({ couponCode: "hello10" });
  assert.equal(q.discountVnd, 10_000);
  assert.equal(q.priceVnd, 90_000);
  assert.equal(q.feeVnd, 0);
  assert.equal(q.playerShareVnd, 90_000, "the player still gets 90.000");
  assert.equal(q.couponCapped, false);
});

test("a coupon bigger than the fee is capped at the fee and the quote says so", () => {
  createCoupon({ code: "BIG50", kind: "PERCENT", value: 50 }, NOW);
  createCoupon({ code: "FIX30K", kind: "FIXED", value: 30_000 }, NOW);
  const capped = quote({ couponCode: "big50" });
  assert.equal(capped.discountVnd, 10_000);
  assert.equal(capped.couponCapped, true);
  assert.equal(quote({ couponCode: "FIX30K" }).discountVnd, 10_000);
  createCoupon({ code: "FIX5K", kind: "FIXED", value: 5_000 }, NOW);
  const small = quote({ couponCode: "FIX5K" });
  assert.deepEqual([small.discountVnd, small.priceVnd, small.feeVnd, small.playerShareVnd, small.couponCapped], [5_000, 95_000, 5_000, 90_000, false]);
});

test("a coupon is refused when it is unknown, off, expired, used up, too small a booking or already used by this person", () => {
  const code = (extra) => createCoupon({ code: "C" + Math.random().toString(36).slice(2, 8).toUpperCase(), kind: "FIXED", value: 5_000, ...extra }, NOW).code;
  assert.throws(() => quote({ couponCode: "NOPE" }), /không đúng hoặc đã bị tắt/);
  const off = code({});
  setCouponActive(off, false);
  assert.throws(() => quote({ couponCode: off }), /không đúng hoặc đã bị tắt/);
  setCouponActive(off, true);
  assert.equal(quote({ couponCode: off }).discountVnd, 5_000);
  assert.throws(() => quote({ couponCode: code({ expiresAt: NOW + HOUR }), now: NOW + 2 * HOUR }), /đã hết hạn/);
  assert.throws(() => quote({ couponCode: code({ minPriceVnd: 200_000 }) }), /từ 200\.000 đ trở lên/);
  const once = code({ maxUses: 1, perUser: 5 });
  book({ customerId: IDS.cust2, playerId: IDS.player, startAt: START + 5 * HOUR, couponCode: once });
  assert.throws(() => quote({ couponCode: once }), /hết lượt dùng/);
  const mine = code({ perUser: 1 });
  book({ customerId: IDS.cust, playerId: IDS.player, startAt: START + 2 * HOUR, couponCode: mine });
  assert.throws(() => quote({ couponCode: mine }), /đã dùng hết số lần/);
  assert.equal(quote({ couponCode: mine, userId: IDS.cust2 }).discountVnd, 5_000, "another person may still use it");
  assert.throws(() => quote({ couponCode: mine, userId: null }), /không đúng/);
});

test("a coupon that takes nothing off is refused instead of pretending", () => {
  saveSettings({ ...getSettings(), feePercent: 0 });
  createCoupon({ code: "ZERO", kind: "PERCENT", value: 20 }, NOW);
  assert.throws(() => quote({ couponCode: "ZERO" }), /không giảm được gì/);
});

test("creating a booking holds the coupon, an unpaid booking that expires or is cancelled gives it back, a paid one keeps it", () => {
  createCoupon({ code: "ONCE", kind: "FIXED", value: 10_000, maxUses: 2, perUser: 1 }, NOW);
  const a = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START, couponCode: "once" });
  assert.deepEqual([a.price_vnd, a.fee_vnd, a.list_price_vnd, a.discount_vnd, a.coupon_code], [90_000, 0, 100_000, 10_000, "ONCE"]);
  assert.equal(getCoupon("ONCE").used, 1);

  expireUnpaid(a.id, NOW + 31 * MIN);
  assert.equal(getCoupon("ONCE").used, 0, "expired unpaid, given back");
  assert.equal(getDb().prepare("SELECT released_at FROM coupon_uses WHERE booking_id = ?").get(a.id).released_at !== null, true);

  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START + 2 * HOUR, couponCode: "ONCE" });
  assert.equal(getCoupon("ONCE").used, 1);
  cancel(b.id, actorFor(b, IDS.cust), NOW + MIN);
  assert.equal(getCoupon("ONCE").used, 0, "cancelled unpaid, given back");
});

test("a paid booking keeps the coupon even when it is cancelled, and the ledger still adds up to what was paid", () => {
  createCoupon({ code: "KEEP", kind: "FIXED", value: 10_000 }, NOW);
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 30 * HOUR, couponCode: "KEEP" });
  pay(b.id, NOW, b.price_vnd);
  const result = cancel(b.id, actorFor(b, IDS.cust), NOW + MIN);
  assert.equal(result.refundVnd, 90_000);
  assert.equal(getCoupon("KEEP").used, 1);
  assert.equal(sum(ledgerRows(b.id)), 90_000);
  assert.equal(ledgerRows(b.id).find((r) => r.kind === "REFUND").amount_vnd, 90_000);
});

test("completing a discounted booking pays the player exactly as without the coupon", () => {
  createCoupon({ code: "PAY", kind: "PERCENT", value: 10 }, NOW);
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR, couponCode: "PAY" });
  pay(b.id, NOW, b.price_vnd);
  getDb().prepare("UPDATE bookings SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?").run(NOW + 2 * HOUR, b.id);
  complete(b.id, SYSTEM, NOW + 3 * HOUR);
  const rows = ledgerRows(b.id);
  assert.equal(rows.find((r) => r.kind === "PLAYER_PAYOUT").amount_vnd, 90_000);
  assert.equal(rows.find((r) => r.kind === "FEE_INCOME")?.amount_vnd ?? 0, 0);
  assert.equal(sum(rows), 90_000);
});

test("coupon creation validates its input, and the report shows what each code cost", () => {
  for (const [input, pattern] of [
    [{ code: "a", kind: "FIXED", value: 1000 }, /3 đến 20 ký tự/],
    [{ code: "OK1", kind: "OTHER", value: 5 }, /Loại mã/],
    [{ code: "OK2", kind: "PERCENT", value: 101 }, /1 đến 100/],
    [{ code: "OK3", kind: "FIXED", value: 0 }, /số nguyên dương/],
    [{ code: "OK4", kind: "FIXED", value: 5, maxUses: 0 }, /lượt dùng/],
    [{ code: "OK5", kind: "FIXED", value: 5, expiresAt: NOW - 1 }, /tương lai/],
  ]) assert.throws(() => createCoupon(input, NOW), pattern);
  createCoupon({ code: "DUP", kind: "FIXED", value: 5000 }, NOW);
  assert.throws(() => createCoupon({ code: "dup", kind: "FIXED", value: 5000 }, NOW), /đã tồn tại/);
  assert.equal(normalizeCode(" he llo-1 "), "HELLO-1");
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START, couponCode: "dup" });
  assert.equal(couponReport().find((r) => r.code === "DUP").discountVnd, 5_000);
  expireUnpaid(b.id, NOW + 31 * MIN);
  assert.equal(couponReport().find((r) => r.code === "DUP").discountVnd, 0);
  assert.equal(listCoupons().length, 1);
});

// ---------------------------------------------------------------- in Discord

const payosOk = () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ code: "00", data: { checkoutUrl: "https://pay.payos.vn/web/abc", paymentLinkId: "abc" } }) });
};
const form = { game: "liên quân", when: "05/10 19:00", duration: "1" };

test("a customer types a code in the booking form and sees the list price, the discount and what to pay", async () => {
  payosOk();
  await env.command(IDS.owner, "magiamgia", { subcommand: "tao", opts: { ma: "hello10", loai: "PERCENT", "gia-tri": 10 } });
  const i = await env.submit(IDS.cust, `bk:new:${IDS.player}`, { ...form, coupon: " hello10 " });
  const embed = lastPayload(i).embeds[0].toJSON();
  assert.ok(embed.fields.some((f) => f.name === "Giá" && /~~100\.000 đ~~ 90\.000 đ/.test(f.value)));
  assert.ok(embed.fields.some((f) => f.name === "Mã giảm giá" && /HELLO10: giảm 10\.000 đ/.test(f.value)));
  assert.equal(getBooking(1).price_vnd, 90_000);
  const order = getDb().prepare("SELECT amount FROM orders").get();
  assert.equal(order.amount, 90_000, "the payment link asks for the discounted price");
});

test("a wrong code stops the booking with a clear message and creates nothing", async () => {
  payosOk();
  const i = await env.submit(IDS.cust, `bk:new:${IDS.player}`, { ...form, coupon: "SAIROI" });
  assert.match(textOf(i), /không đúng hoặc đã bị tắt/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);
});

test("when the payment link cannot be made the coupon is given back", async () => {
  createCoupon({ code: "GIVEBACK", kind: "FIXED", value: 5000, maxUses: 1 }, NOW);
  globalThis.fetch = async () => {
    throw new Error("payOS down");
  };
  const original = console.error;
  console.error = () => {};
  try {
    await env.submit(IDS.cust, `bk:new:${IDS.player}`, { ...form, coupon: "GIVEBACK" });
  } finally {
    console.error = original;
  }
  assert.equal(getBooking(1).status, "CANCELLED");
  assert.equal(getCoupon("GIVEBACK").used, 0);
});

test("/magiamgia is for owners, creates, lists, switches off and on", async () => {
  for (const user of [IDS.staff, IDS.cust, IDS.rando]) assert.match(textOf(await env.command(user, "magiamgia", { subcommand: "danh-sach" })), /không có quyền/);
  const made = await env.command(IDS.owner, "magiamgia", { subcommand: "tao", opts: { ma: "vip20", loai: "FIXED", "gia-tri": 20_000, "toi-da": 5, "moi-nguoi": 2, "gia-toi-thieu": 50_000, "han-ngay": 7 } });
  assert.match(textOf(made), /Đã tạo mã VIP20/);
  assert.match(textOf(made), /phần của player không đổi/);
  assert.equal(getCoupon("VIP20").maxUses, 5);
  assert.equal(getCoupon("VIP20").expiresAt, NOW + 7 * DAY);
  const bad = await env.command(IDS.owner, "magiamgia", { subcommand: "tao", opts: { ma: "x", loai: "FIXED", "gia-tri": 1000 } });
  assert.match(textOf(bad), /3 đến 20 ký tự/);
  assert.match(textOf(await env.command(IDS.owner, "magiamgia", { subcommand: "danh-sach" })), /VIP20.*dùng 0\/5.*mỗi người 2 lần.*từ 50\.000 đ/);
  assert.match(textOf(await env.command(IDS.owner, "magiamgia", { subcommand: "tat", opts: { ma: "vip20" } })), /đã tắt/);
  assert.equal(getCoupon("VIP20").active, false);
  assert.match(textOf(await env.command(IDS.owner, "magiamgia", { subcommand: "bat", opts: { ma: "vip20" } })), /đã bật lại/);
  assert.match(textOf(await env.command(IDS.owner, "magiamgia", { subcommand: "tat", opts: { ma: "khongco" } })), /không đúng/);
});

// ---------------------------------------------------------------- admin settings for peaks and packages

test("the owner sets peak hours and top-up packages from forms, and the answer shows what was stored", async () => {
  const open = await env.command(IDS.owner, "admin", { subcommand: "cai-dat", opts: { nhom: "caodiem" } });
  assert.equal(modalOf(open).toJSON().custom_id, "ad:settings:caodiem");
  const saved = await env.submit(IDS.owner, "ad:settings:caodiem", { peaks: "T6 T7 19:00-23:00 +20" });
  assert.match(textOf(saved), /T6 T7 19:00-23:00 \+20/);
  assert.equal(getSettings().peaks.length, 1);
  assert.match(textOf(await env.submit(IDS.owner, "ad:settings:caodiem", { peaks: "lung tung" })), /chưa đúng/);
  assert.equal(getSettings().peaks.length, 1, "a bad form changes nothing");
  assert.match(textOf(await env.submit(IDS.owner, "ad:settings:caodiem", { peaks: "" })), /Không có giá cao điểm/);
  assert.deepEqual(getSettings().peaks, []);

  const pk = await env.command(IDS.owner, "admin", { subcommand: "cai-dat", opts: { nhom: "goinap" } });
  assert.equal(modalOf(pk).toJSON().custom_id, "ad:settings:goinap");
  assert.match(textOf(await env.submit(IDS.owner, "ad:settings:goinap", { packages: "300k +3\n1tr +10" })), /chưa đúng/);
  assert.match(textOf(await env.submit(IDS.owner, "ad:settings:goinap", { packages: "300000 +3\n1000000 +12" })), /Nạp 300\.000 đ, tặng thêm 3%/);
  assert.equal(getSettings().packages[1].bonusPercent, 12);
});

test("the extras form stores nested loyalty values and the audit log shows who changed what", async () => {
  const saved = await env.submit(IDS.owner, "ad:settings:tienich", { maxExtendMin: "60", waitlistHoldMin: "45", maxSeriesWeeks: "4", earnPerVnd: "2000", pointValueVnd: "80" });
  assert.match(saved.out.map((o) => JSON.stringify(o.payload)).join(" "), /earnPerVnd|Mỗi bao nhiêu VND/);
  const s = getSettings();
  assert.deepEqual([s.maxExtendMin, s.waitlistHoldMin, s.maxSeriesWeeks, s.loyalty.earnPerVnd, s.loyalty.pointValueVnd, s.loyalty.minRedeem], [60, 45, 4, 2000, 80, 100]);
  const log = await env.command(IDS.owner, "admin", { subcommand: "nhat-ky", opts: { "so-dong": 10 } });
  assert.match(textOf(log), /ad:settings:tienich/);
  assert.match(textOf(await env.command(IDS.staff, "admin", { subcommand: "nhat-ky" })), /không có quyền/);
});
