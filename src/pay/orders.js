import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "../domain/errors.js";
import { MINUTE } from "../domain/time.js";

// One order per payment attempt. There are three kinds:
//   BOOKING  the price of a booking (booking_id is the booking)
//   EXTEND   more time in a session that is running (booking_id is the booking, extra_min and extra_fee say what it buys)
//   TOPUP    credit for the wallet (booking_id is 0, bonus_vnd is the bonus the package gives)
// `provider` says which gateway made the link and `external_id` is that gateway's own id for it.

// How long an order is still polled. It outlives the booking's payment window and the payOS link (both 30 minutes by default),
// so a payment that lands in the last seconds is still seen and, if the booking has expired meanwhile, refunded.
export const ORDER_TTL_MS = 35 * MINUTE;

// payOS wants a number code that is unique per payment link
export function newOrderCode(now = Date.now(), random = Math.random) {
  return Math.floor(now / 1000) * 1000 + Math.floor(random() * 1000);
}

// At most 9 characters: BOOK (or NAP, GIAHAN) + the last digits of the code
const PREFIX = { BOOKING: "BOOK", EXTEND: "GIA", TOPUP: "NAP" };
export const describeOrder = (orderCode, kind = "BOOKING") => `${PREFIX[kind] ?? "BOOK"}${String(orderCode % 100000).padStart(9 - (PREFIX[kind] ?? "BOOK").length, "0")}`.slice(0, 9);

function insertOrder(db, { orderCode, bookingId, userId, amount, kind, provider, now, extraMin = 0, extraFee = 0, bonusVnd = 0 }) {
  db.prepare(
    "INSERT INTO orders (order_code, booking_id, user_id, amount, status, created_at, kind, provider, extra_min, extra_fee, bonus_vnd) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)",
  ).run(orderCode, bookingId, userId, amount, now, kind, provider, extraMin, extraFee, bonusVnd);
}

function freshCode(db, now, random) {
  let orderCode = newOrderCode(now, random);
  while (db.prepare("SELECT 1 FROM orders WHERE order_code = ?").get(orderCode)) orderCode += 1;
  return orderCode;
}

// createBookingOrder(bookingId, now, random?, settings?, provider?) -> { orderCode, amount, description, expiredAt }
// For a booking that is AWAITING_PAYMENT and has no order still pending. expiredAt is unix seconds for the gateway.
export function createBookingOrder(bookingId, now = Date.now(), random = Math.random, settings = getSettings(), provider = "payos") {
  return transaction(() => {
    const db = getDb();
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (booking.status !== "AWAITING_PAYMENT") fail("ILLEGAL_TRANSITION", { status: booking.status, action: "order" });
    if (db.prepare("SELECT 1 FROM orders WHERE booking_id = ? AND kind = 'BOOKING' AND status = 'PENDING'").get(bookingId)) fail("ORDER_EXISTS");
    const orderCode = freshCode(db, now, random);
    insertOrder(db, { orderCode, bookingId, userId: booking.customer_id, amount: booking.price_vnd, kind: "BOOKING", provider, now });
    db.prepare("UPDATE bookings SET order_code = ? WHERE id = ?").run(orderCode, bookingId);
    return {
      orderCode,
      amount: booking.price_vnd,
      description: describeOrder(orderCode),
      expiredAt: Math.floor((booking.created_at + settings.unpaidExpireMin * MINUTE) / 1000),
    };
  });
}

// createTopupOrder(userId, amountVnd, bonusVnd, now, random?, provider?) -> { orderCode, amount, description, expiredAt }
export function createTopupOrder(userId, amountVnd, bonusVnd, now = Date.now(), random = Math.random, provider = "payos") {
  return transaction(() => {
    const db = getDb();
    const orderCode = freshCode(db, now, random);
    insertOrder(db, { orderCode, bookingId: 0, userId, amount: amountVnd, kind: "TOPUP", provider, now, bonusVnd });
    return { orderCode, amount: amountVnd, description: describeOrder(orderCode, "TOPUP"), expiredAt: Math.floor((now + ORDER_TTL_MS - 5 * MINUTE) / 1000) };
  });
}

// createExtendOrder(bookingId, extraMin, amountVnd, feeVnd, now, random?, provider?) -> { orderCode, amount, description, expiredAt }
// Only one extension waits for payment per booking, so two links can never be paid for the same minutes.
export function createExtendOrder(bookingId, extraMin, amountVnd, feeVnd, now = Date.now(), random = Math.random, provider = "payos") {
  return transaction(() => {
    const db = getDb();
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (db.prepare("SELECT 1 FROM orders WHERE booking_id = ? AND kind = 'EXTEND' AND status = 'PENDING' AND created_at > ?").get(bookingId, now - ORDER_TTL_MS)) fail("ORDER_EXISTS");
    const orderCode = freshCode(db, now, random);
    insertOrder(db, { orderCode, bookingId, userId: booking.customer_id, amount: amountVnd, kind: "EXTEND", provider, now, extraMin, extraFee: feeVnd });
    return { orderCode, amount: amountVnd, description: describeOrder(orderCode, "EXTEND"), expiredAt: Math.floor((now + 15 * MINUTE) / 1000) };
  });
}

export function setCheckoutUrl(orderCode, url, externalId = null) {
  getDb().prepare("UPDATE orders SET checkout_url = ?, external_id = COALESCE(?, external_id) WHERE order_code = ?").run(url, externalId, orderCode);
}

export function getOrder(orderCode) {
  return getDb().prepare("SELECT * FROM orders WHERE order_code = ?").get(orderCode) ?? null;
}

export function pendingOrderFor(bookingId) {
  return getDb().prepare("SELECT * FROM orders WHERE booking_id = ? AND kind = 'BOOKING' AND status = 'PENDING' ORDER BY created_at DESC").get(bookingId) ?? null;
}

export function pendingOrders(now = Date.now()) {
  return getDb().prepare("SELECT * FROM orders WHERE status = 'PENDING' AND created_at > ? ORDER BY created_at").all(now - ORDER_TTL_MS);
}

// The extension minutes that are paid for or being paid for, which must stay free for the session they belong to
export function pendingExtensions(playerId, now = Date.now()) {
  return getDb()
    .prepare(
      `SELECT b.start_at + b.duration_min * 60000 AS start_at, o.extra_min FROM orders o JOIN bookings b ON b.id = o.booking_id
       WHERE o.kind = 'EXTEND' AND o.status = 'PENDING' AND o.created_at > ? AND b.player_id = ?`,
    )
    .all(now - ORDER_TTL_MS, playerId)
    .map((r) => ({ start_at: r.start_at, end_at: r.start_at + r.extra_min * MINUTE }));
}

export function recentOrders(limit = 10) {
  return getDb().prepare("SELECT order_code, booking_id, user_id, amount, status, created_at, paid_at, kind, provider FROM orders ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function closeOrder(orderCode, status) {
  getDb().prepare("UPDATE orders SET status = ? WHERE order_code = ? AND status = 'PENDING'").run(status, orderCode);
}

// Orders still pending after their time is up can no longer be paid
export function expireStaleOrders(now = Date.now()) {
  return Number(getDb().prepare("UPDATE orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND created_at <= ?").run(now - ORDER_TTL_MS).changes);
}

// Flips an order PENDING -> PAID. The flip is the guard: only the call that performs it gets the order back, every later call gets null.
export function settleOrder(orderCode, now = Date.now()) {
  const order = getOrder(orderCode);
  if (!order) return null;
  const flipped = Number(getDb().prepare("UPDATE orders SET status = 'PAID', paid_at = ? WHERE order_code = ? AND status = 'PENDING'").run(now, orderCode).changes);
  return flipped ? { ...order, status: "PAID", paid_at: now } : null;
}
