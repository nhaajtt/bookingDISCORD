import { randomBytes } from "node:crypto";
import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { isBlacklisted } from "./strikes.js";

// Referral. Everyone has one short code. A newcomer who enters a friend's code before their first booking links the two; when the
// newcomer finishes their first session worth enough, both get wallet credit paid by the owner (settings.referral). One link per
// newcomer, never to themselves, never when either side is blacklisted, and the reward is written once for the booking that earned it.

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => Array.from(randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");
export const normalizeReferralCode = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function referralCodeFor(userId, now = Date.now()) {
  const db = getDb();
  const have = db.prepare("SELECT code FROM referral_codes WHERE user_id = ?").get(userId);
  if (have) return have.code;
  for (let i = 0; i < 20; i += 1) {
    const made = Number(db.prepare("INSERT OR IGNORE INTO referral_codes (user_id, code, created_at) VALUES (?, ?, ?)").run(userId, makeCode(), now).changes);
    const mine = db.prepare("SELECT code FROM referral_codes WHERE user_id = ?").get(userId);
    if (made || mine) return mine.code;
  }
  throw new Error("could not make a referral code");
}

const hasBooked = (userId) => Boolean(getDb().prepare("SELECT 1 FROM bookings WHERE customer_id = ? AND status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','DISPUTED') LIMIT 1").get(userId));

// useReferralCode(refereeId, code, now) -> { referrerId }
export function useReferralCode(refereeId, code, now = Date.now(), settings = getSettings()) {
  if (!settings.referral.rewardVnd) fail("INVALID_INPUT", { message: "Chương trình giới thiệu đang tắt." });
  return transaction(() => {
    const db = getDb();
    const clean = normalizeReferralCode(code);
    const owner = db.prepare("SELECT user_id FROM referral_codes WHERE code = ?").get(clean);
    if (!owner) fail("INVALID_INPUT", { message: "Mã giới thiệu không đúng." });
    if (owner.user_id === refereeId) fail("INVALID_INPUT", { message: "Bạn không thể dùng mã của chính mình." });
    if (isBlacklisted(refereeId) || isBlacklisted(owner.user_id)) fail("BLACKLISTED");
    if (db.prepare("SELECT 1 FROM referrals WHERE referee_id = ?").get(refereeId)) fail("INVALID_INPUT", { message: "Bạn đã nhập mã giới thiệu rồi." });
    if (hasBooked(refereeId)) fail("INVALID_INPUT", { message: "Mã giới thiệu chỉ dùng được trước khi bạn đặt lịch lần đầu." });
    db.prepare("INSERT INTO referrals (referee_id, referrer_id, code, created_at) VALUES (?, ?, ?, ?)").run(refereeId, owner.user_id, clean, now);
    return { referrerId: owner.user_id };
  });
}

// rewardReferral(booking, now): called inside complete(). The first completed session of a referred customer pays both sides once.
export function rewardReferral(booking, now = Date.now(), settings = getSettings()) {
  const { rewardVnd, minPriceVnd } = settings.referral;
  if (!rewardVnd) return null;
  const db = getDb();
  const link = db.prepare("SELECT * FROM referrals WHERE referee_id = ? AND rewarded_at IS NULL").get(booking.customer_id);
  if (!link || booking.price_vnd < minPriceVnd) return null;
  if (isBlacklisted(link.referrer_id) || isBlacklisted(booking.customer_id)) return null;
  const won = Number(db.prepare("UPDATE referrals SET rewarded_at = ?, booking_id = ? WHERE referee_id = ? AND rewarded_at IS NULL").run(now, booking.id, booking.customer_id).changes);
  if (!won) return null;
  const add = db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'BONUS', ?, ?)");
  add.run(link.referrer_id, rewardVnd, `thưởng giới thiệu (lịch #${booking.id})`, now);
  add.run(booking.customer_id, rewardVnd, `thưởng được giới thiệu (lịch #${booking.id})`, now);
  return { referrerId: link.referrer_id, refereeId: booking.customer_id, rewardVnd };
}

export function referralStats(userId) {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS invited, COALESCE(SUM(rewarded_at IS NOT NULL), 0) AS rewarded FROM referrals WHERE referrer_id = ?").get(userId);
  const { rewardVnd } = getSettings().referral;
  return { invited: Number(row.invited), rewarded: Number(row.rewarded), earnedVnd: Number(row.rewarded) * rewardVnd, rewardVnd, referredBy: db.prepare("SELECT referrer_id FROM referrals WHERE referee_id = ?").get(userId)?.referrer_id ?? null };
}
