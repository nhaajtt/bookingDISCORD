import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { DAY } from "./time.js";
import { fail } from "./errors.js";

// Strikes record broken commitments (a player cancelling or not showing up, a customer not showing up). Reaching the limit inside the
// window suspends a player. Strikes of customers are only counted; the owner decides about them (blacklist).

export function activeStrikeCount(userId, now = Date.now(), settings = getSettings()) {
  const since = now - settings.strikeWindowDays * DAY;
  return Number(
    getDb().prepare("SELECT COUNT(*) AS n FROM strikes WHERE user_id = ? AND cleared_at IS NULL AND created_at > ?").get(userId, since).n,
  );
}

export function listStrikes(userId) {
  return getDb().prepare("SELECT id, user_id, booking_id, reason, created_at, cleared_at FROM strikes WHERE user_id = ? ORDER BY id").all(userId);
}

// addStrike(userId, bookingId, reason, now, settings?) -> { added, count, suspended }
// The same (user, booking, reason) is recorded once, so a transition that runs twice cannot strike twice.
export function addStrike(userId, bookingId, reason, now = Date.now(), settings = getSettings()) {
  return transaction(() => {
    const db = getDb();
    const added = Number(db.prepare("INSERT OR IGNORE INTO strikes (user_id, booking_id, reason, created_at) VALUES (?, ?, ?, ?)").run(userId, bookingId ?? null, reason, now).changes) > 0;
    const count = activeStrikeCount(userId, now, settings);
    let suspended = false;
    if (count >= settings.strikeLimit) {
      suspended = Number(db.prepare("UPDATE players SET status = 'SUSPENDED' WHERE user_id = ? AND status IN ('ACTIVE','PAUSED')").run(userId).changes) > 0;
    }
    return { added, count, suspended };
  });
}

// Ends a suspension and clears the strikes that caused it, so the player starts again from zero
export function liftSuspension(userId, by, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const flipped = Number(db.prepare("UPDATE players SET status = 'ACTIVE' WHERE user_id = ? AND status = 'SUSPENDED'").run(userId).changes);
    if (!flipped) fail("NOT_FOUND", { what: "player đang bị tạm khoá" });
    db.prepare("UPDATE strikes SET cleared_at = ? WHERE user_id = ? AND cleared_at IS NULL").run(now, userId);
    return { userId, liftedBy: by, at: now };
  });
}

export function clearStrikesForBooking(bookingId, now = Date.now()) {
  return Number(getDb().prepare("UPDATE strikes SET cleared_at = ? WHERE booking_id = ? AND cleared_at IS NULL").run(now, bookingId).changes);
}

export function addToBlacklist(userId, reason, byUserId, now = Date.now()) {
  const clean = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!clean) fail("INVALID_INPUT", { message: "Cần ghi lý do khi cấm người dùng." });
  getDb()
    .prepare("INSERT INTO blacklist (user_id, reason, by_user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, by_user_id = excluded.by_user_id")
    .run(userId, clean, byUserId ?? null, now);
  return getBlacklistEntry(userId);
}

export function removeFromBlacklist(userId) {
  return Number(getDb().prepare("DELETE FROM blacklist WHERE user_id = ?").run(userId).changes) > 0;
}

export function getBlacklistEntry(userId) {
  const row = getDb().prepare("SELECT user_id, reason, by_user_id, created_at FROM blacklist WHERE user_id = ?").get(userId);
  return row ? { userId: row.user_id, reason: row.reason, byUserId: row.by_user_id, createdAt: row.created_at } : null;
}

export const isBlacklisted = (userId) => getBlacklistEntry(userId) !== null;

export function listBlacklist() {
  return getDb().prepare("SELECT user_id, reason, by_user_id, created_at FROM blacklist ORDER BY created_at DESC").all();
}
