import { getDb, transaction } from "../db.js";
import { fail } from "./errors.js";
import { sanitizeText } from "./ratings.js";

// Discount codes. A coupon is paid for out of the platform fee, never out of the player's share: the discount can be at most the fee of
// the booking, the player is paid exactly what they would have been, and the booking records both the list price and the discount.
// A code is held by a booking while it waits for payment and released again if the booking expires or is cancelled unpaid.

export const CODE = /^[A-Z0-9_-]{3,20}$/;

export function normalizeCode(text) {
  return String(text ?? "").toUpperCase().replace(/\s+/g, "");
}

const row = (r) =>
  r && {
    code: r.code,
    kind: r.kind,
    value: r.value,
    maxUses: r.max_uses,
    used: r.used,
    perUser: r.per_user,
    minPriceVnd: r.min_price_vnd,
    expiresAt: r.expires_at,
    active: Boolean(r.active),
    note: r.note,
    createdAt: r.created_at,
  };

export const getCoupon = (code) => row(getDb().prepare("SELECT * FROM coupons WHERE code = ?").get(normalizeCode(code)));
export const listCoupons = () => getDb().prepare("SELECT * FROM coupons ORDER BY created_at DESC, code").all().map(row);

// createCoupon({ code, kind: "PERCENT" | "FIXED", value, maxUses?, perUser?, minPriceVnd?, expiresAt?, note? }, now) -> coupon
export function createCoupon({ code, kind, value, maxUses = null, perUser = 1, minPriceVnd = 0, expiresAt = null, note = "" }, now = Date.now()) {
  const clean = normalizeCode(code);
  if (!CODE.test(clean)) fail("INVALID_INPUT", { message: "Mã chỉ gồm chữ không dấu, số, gạch ngang hoặc gạch dưới, dài 3 đến 20 ký tự." });
  if (kind !== "PERCENT" && kind !== "FIXED") fail("INVALID_INPUT", { message: "Loại mã phải là phần trăm hoặc số tiền." });
  if (!Number.isInteger(value) || value < 1 || (kind === "PERCENT" && value > 100)) fail("INVALID_INPUT", { message: kind === "PERCENT" ? "Phần trăm giảm từ 1 đến 100." : "Số tiền giảm phải là số nguyên dương." });
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) fail("INVALID_INPUT", { message: "Số lượt dùng tối đa phải từ 1 trở lên." });
  if (!Number.isInteger(perUser) || perUser < 1 || perUser > 100) fail("INVALID_INPUT", { message: "Số lần mỗi người dùng được từ 1 đến 100." });
  if (!Number.isInteger(minPriceVnd) || minPriceVnd < 0) fail("INVALID_INPUT", { message: "Giá tối thiểu không hợp lệ." });
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= now)) fail("INVALID_INPUT", { message: "Ngày hết hạn phải ở tương lai." });
  if (getCoupon(clean)) fail("INVALID_INPUT", { message: `Mã ${clean} đã tồn tại.` });
  getDb()
    .prepare("INSERT INTO coupons (code, kind, value, max_uses, per_user, min_price_vnd, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(clean, kind, value, maxUses, perUser, minPriceVnd, expiresAt, sanitizeText(note, 100) || null, now);
  return getCoupon(clean);
}

export function setCouponActive(code, active) {
  const changed = Number(getDb().prepare("UPDATE coupons SET active = ? WHERE code = ?").run(active ? 1 : 0, normalizeCode(code)).changes);
  if (!changed) fail("COUPON_INVALID");
  return getCoupon(code);
}

// couponDiscount(code, { userId, listPriceVnd, feeVnd, now }) -> { coupon, discountVnd, capped }
// Checks the code for this person and price, and says how much it takes off. Nothing is recorded: redeemCoupon does that.
export function couponDiscount(code, { userId, listPriceVnd, feeVnd, now = Date.now() }) {
  const coupon = getCoupon(code);
  if (!coupon || !coupon.active) fail("COUPON_INVALID");
  if (coupon.expiresAt !== null && now >= coupon.expiresAt) fail("COUPON_EXPIRED");
  if (coupon.maxUses !== null && coupon.used >= coupon.maxUses) fail("COUPON_USED_UP");
  if (listPriceVnd < coupon.minPriceVnd) fail("COUPON_MIN_PRICE", { min: coupon.minPriceVnd });
  const mine = Number(getDb().prepare("SELECT COUNT(*) AS n FROM coupon_uses WHERE code = ? AND user_id = ? AND released_at IS NULL").get(coupon.code, userId).n);
  if (mine >= coupon.perUser) fail("COUPON_ALREADY_USED");
  const wanted = coupon.kind === "PERCENT" ? Math.floor((listPriceVnd * coupon.value) / 100) : coupon.value;
  const discountVnd = Math.min(wanted, feeVnd);
  if (discountVnd <= 0) fail("COUPON_NO_EFFECT");
  return { coupon, discountVnd, capped: discountVnd < wanted };
}

// redeemCoupon(bookingId, code, userId, discountVnd, now): counts one use for this booking. Throws COUPON_USED_UP when the last use
// was taken in the meantime. Call inside the transaction that creates the booking.
export function redeemCoupon(bookingId, code, userId, discountVnd, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const clean = normalizeCode(code);
    const took = Number(db.prepare("UPDATE coupons SET used = used + 1 WHERE code = ? AND active = 1 AND (max_uses IS NULL OR used < max_uses)").run(clean).changes);
    if (!took) fail("COUPON_USED_UP");
    db.prepare("INSERT INTO coupon_uses (booking_id, code, user_id, discount_vnd, at) VALUES (?, ?, ?, ?, ?)").run(bookingId, clean, userId, discountVnd, now);
  });
}

// releaseCoupon(bookingId, now) -> true when a held use was given back (the booking expired or was cancelled before it was paid)
export function releaseCoupon(bookingId, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const use = db.prepare("SELECT code FROM coupon_uses WHERE booking_id = ? AND released_at IS NULL").get(bookingId);
    if (!use) return false;
    db.prepare("UPDATE coupon_uses SET released_at = ? WHERE booking_id = ?").run(now, bookingId);
    db.prepare("UPDATE coupons SET used = MAX(0, used - 1) WHERE code = ?").run(use.code);
    return true;
  });
}

// What a coupon has cost the owner so far: total discount of uses that stuck
export function couponReport() {
  return getDb()
    .prepare(
      `SELECT c.code, c.kind, c.value, c.used, c.max_uses AS maxUses, c.active, c.expires_at AS expiresAt,
              COALESCE(SUM(CASE WHEN u.released_at IS NULL THEN u.discount_vnd END), 0) AS discountVnd
       FROM coupons c LEFT JOIN coupon_uses u ON u.code = c.code GROUP BY c.code ORDER BY c.created_at DESC, c.code`,
    )
    .all();
}
