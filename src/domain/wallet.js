import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { pay } from "./bookings.js";
import { applyExtension, quoteExtension } from "./extensions.js";
import { sanitizeText } from "./ratings.js";

// A customer's prepaid credit. Money paid into the wallet is still money in the owner's payOS account; the wallet is only what the
// owner owes back as service. Paying a booking from it uses exactly the same booking, ledger and payout rules as paying by link, and a
// refund of a wallet-paid booking goes back into the wallet at once (no manual transfer). The balance is the sum of the rows, so it
// can never disagree with the history, and every credit is keyed so that the same payment cannot be credited twice.

export const walletBalance = (userId) => Number(getDb().prepare("SELECT COALESCE(SUM(amount_vnd), 0) AS v FROM wallet_tx WHERE user_id = ?").get(userId).v);

export const walletHistory = (userId, limit = 10) => getDb().prepare("SELECT * FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit);

// The credit the owner still owes in service across every customer (shown in the owner's numbers)
export function walletLiability() {
  const row = getDb().prepare("SELECT COALESCE(SUM(amount_vnd), 0) AS v, COUNT(DISTINCT user_id) AS people FROM wallet_tx").get();
  return { vnd: Number(row.v), people: Number(row.people) };
}

// What the bonus of a package has cost so far
export const bonusGiven = () => Number(getDb().prepare("SELECT COALESCE(SUM(amount_vnd), 0) AS v FROM wallet_tx WHERE kind = 'BONUS'").get().v);

export const bonusFor = (amountVnd, bonusPercent) => Math.floor((amountVnd * bonusPercent) / 100);

export function packageFor(amountVnd, settings = getSettings()) {
  const found = settings.packages.find((p) => p.amountVnd === amountVnd);
  if (!found) fail("INVALID_INPUT", { message: "Gói nạp này không còn nữa." });
  return found;
}

// creditTopup(orderCode, userId, amountVnd, bonusVnd, now) -> { created }. Called when the payment of a top-up order is confirmed.
export function creditTopup(orderCode, userId, amountVnd, bonusVnd, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const first = Number(db.prepare("INSERT OR IGNORE INTO wallet_tx (user_id, amount_vnd, kind, order_code, note, created_at) VALUES (?, ?, 'TOPUP', ?, ?, ?)").run(userId, amountVnd, orderCode, "nạp ví", now).changes) > 0;
    if (first && bonusVnd > 0) db.prepare("INSERT OR IGNORE INTO wallet_tx (user_id, amount_vnd, kind, order_code, note, created_at) VALUES (?, ?, 'BONUS', ?, ?, ?)").run(userId, bonusVnd, orderCode, "tặng thêm khi nạp", now);
    return { created: first };
  });
}

// payFromWallet(bookingId, customerId, now) -> { booking, balance }
// AWAITING_PAYMENT -> CONFIRMED, paid from the wallet. Refused when the balance is too low or a payment link is still open for the
// booking (the customer must not be able to pay twice).
export function payFromWallet(bookingId, customerId, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (booking.customer_id !== customerId) fail("FORBIDDEN_ACTOR");
    if (booking.status !== "AWAITING_PAYMENT") fail("ILLEGAL_TRANSITION", { status: booking.status, action: "pay" });
    if (now >= booking.created_at + getSettings().unpaidExpireMin * 60_000) fail("TOO_LATE");
    if (db.prepare("SELECT 1 FROM orders WHERE booking_id = ? AND kind = 'BOOKING' AND status = 'PENDING'").get(bookingId)) fail("ORDER_EXISTS");
    const balance = walletBalance(customerId);
    if (balance < booking.price_vnd) fail("WALLET_LOW", { balance });
    db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, booking_id, note, created_at) VALUES (?, ?, 'SPEND', ?, ?, ?)").run(customerId, -booking.price_vnd, bookingId, `lịch #${bookingId}`, now);
    const result = pay(bookingId, now, booking.price_vnd);
    db.prepare("UPDATE bookings SET paid_with = 'WALLET' WHERE id = ?").run(bookingId);
    return { booking: { ...result.booking, paid_with: "WALLET" }, balance: balance - booking.price_vnd };
  });
}

// payExtensionFromWallet(bookingId, customerId, extraMin, now, settings) -> { booking, priceVnd, balance }
// More time for a session that was itself paid from the wallet: the price comes out of the wallet and the session grows at once.
export function payExtensionFromWallet(bookingId, customerId, extraMin, now = Date.now(), settings = getSettings()) {
  return transaction(() => {
    const quote = quoteExtension(bookingId, extraMin, now, settings);
    if (quote.booking.customer_id !== customerId) fail("FORBIDDEN_ACTOR");
    if (quote.booking.paid_with !== "WALLET") fail("NOT_EXTENDABLE", { message: "Buổi này không thanh toán bằng ví nên không gia hạn bằng ví được." });
    const balance = walletBalance(customerId);
    if (balance < quote.priceVnd) fail("WALLET_LOW", { balance });
    getDb().prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'SPEND', ?, ?)").run(customerId, -quote.priceVnd, `gia hạn lịch #${bookingId}`, now);
    const booking = applyExtension(bookingId, extraMin, quote.priceVnd, quote.feeVnd, now);
    return { booking, priceVnd: quote.priceVnd, balance: balance - quote.priceVnd };
  });
}

// adjustWallet(userId, amountVnd, note, now): the owner's hand-made correction, positive or negative, never below zero in total
export function adjustWallet(userId, amountVnd, note, now = Date.now()) {
  if (!Number.isInteger(amountVnd) || amountVnd === 0) fail("INVALID_INPUT", { message: "Số tiền điều chỉnh phải là số nguyên khác 0." });
  const text = sanitizeText(note, 100);
  if (!text) fail("INVALID_INPUT", { message: "Cần ghi lý do điều chỉnh." });
  return transaction(() => {
    if (walletBalance(userId) + amountVnd < 0) fail("INVALID_INPUT", { message: "Ví không thể âm sau khi điều chỉnh." });
    getDb().prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'ADJUST', ?, ?)").run(userId, amountVnd, text, now);
    return walletBalance(userId);
  });
}

// ---------------------------------------------------------------- loyalty points

// 1 point per earnPerVnd spent on completed sessions, less what was already turned into credit
export function loyaltyPoints(userId, settings = getSettings()) {
  const { earnPerVnd, pointValueVnd, minRedeem } = settings.loyalty;
  if (!earnPerVnd) return { enabled: false, earned: 0, redeemed: 0, available: 0, pointValueVnd, minRedeem };
  const spent = Number(getDb().prepare("SELECT COALESCE(SUM(price_vnd), 0) AS v FROM bookings WHERE customer_id = ? AND status = 'COMPLETED'").get(userId).v);
  const earned = Math.floor(spent / earnPerVnd);
  const redeemed = Number(getDb().prepare("SELECT redeemed_points AS v FROM loyalty WHERE user_id = ?").get(userId)?.v ?? 0);
  return { enabled: true, earned, redeemed, available: Math.max(0, earned - redeemed), pointValueVnd, minRedeem };
}

// redeemPoints(userId, points, now, settings) -> { points, creditVnd, balance }
export function redeemPoints(userId, points, now = Date.now(), settings = getSettings()) {
  return transaction(() => {
    const info = loyaltyPoints(userId, settings);
    if (!info.enabled) fail("INVALID_INPUT", { message: "Chương trình điểm đang tắt." });
    if (!Number.isInteger(points) || points < info.minRedeem) fail("INVALID_INPUT", { message: `Đổi tối thiểu ${info.minRedeem} điểm một lần.` });
    if (points > info.available) fail("INVALID_INPUT", { message: `Bạn chỉ có ${info.available} điểm có thể đổi.` });
    const creditVnd = points * info.pointValueVnd;
    const db = getDb();
    db.prepare("INSERT INTO loyalty (user_id, redeemed_points) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET redeemed_points = redeemed_points + excluded.redeemed_points").run(userId, points);
    db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'POINTS', ?, ?)").run(userId, creditVnd, `đổi ${points} điểm`, now);
    return { points, creditVnd, balance: walletBalance(userId) };
  });
}
