import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { HOUR } from "./time.js";

// Free text from users is cleaned before it is stored or shown: no mentions (so nobody can ping a role or everyone through the bot),
// no links, control characters removed, spaces collapsed, length cut by characters rather than bytes.
export function sanitizeText(input, max = 500) {
  const cleaned = String(input ?? "")
    .replace(/<(?:@[!&]?|#|\/)[^>\s]*>/g, "")
    .replace(/@(everyone|here)/gi, "")
    .replace(/@/g, "")
    .replace(/(?:https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/)\S*/gi, "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, max).join("").trim();
}

export const sanitizeReview = (text, max = 500) => sanitizeText(text, max);

// recordRating(bookingId, customerId, stars, review, now, settings?) -> { booking, player }
// Only the customer of a COMPLETED booking, once, within the review window after the session ended.
export function recordRating(bookingId, customerId, stars, review = "", now = Date.now(), settings = getSettings()) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail("BAD_STARS");
  return transaction(() => {
    const db = getDb();
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (booking.customer_id !== customerId) fail("FORBIDDEN_ACTOR");
    if (booking.status !== "COMPLETED") fail("NOT_RATEABLE");
    if (booking.rating !== null) fail("ALREADY_RATED");
    if (now > booking.ended_at + settings.reviewWindowHours * HOUR) fail("REVIEW_CLOSED");
    // The IS NULL guard is what makes "once" true even if two clicks race
    const changed = Number(db.prepare("UPDATE bookings SET rating = ?, review = ? WHERE id = ? AND rating IS NULL").run(stars, sanitizeReview(review), bookingId).changes);
    if (!changed) fail("ALREADY_RATED");
    db.prepare("UPDATE players SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE user_id = ?").run(stars, booking.player_id);
    return { booking: db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId), player: playerRating(booking.player_id) };
  });
}

// { average (two decimals, 0 without ratings), count, completed }
export function playerRating(userId) {
  const p = getDb().prepare("SELECT rating_sum, rating_count, completed FROM players WHERE user_id = ?").get(userId);
  if (!p) return { average: 0, count: 0, completed: 0 };
  return { average: p.rating_count ? Math.round((p.rating_sum / p.rating_count) * 100) / 100 : 0, count: p.rating_count, completed: p.completed };
}

// A player is trusted with enough completed sessions and a high enough average, and only while ACTIVE
export function isTrusted(player, settings = getSettings()) {
  if (!player || player.status !== "ACTIVE") return false;
  // works on a database row or on a player from players.getPlayer
  const sum = player.rating_sum ?? player.ratingSum ?? 0;
  const count = player.rating_count ?? player.ratingCount ?? 0;
  const average = count ? sum / count : 0;
  return player.completed >= settings.trusted.minCompleted && average >= settings.trusted.minAverage;
}

// trustedRoleChanges(currentHolderIds, settings?) -> { gain: [userId], lose: [userId] }
// currentHolderIds are the users who hold the trusted role in Discord right now. `gain` are eligible players without it,
// `lose` are holders who no longer qualify (average dropped, paused, suspended, or not a player at all).
export function trustedRoleChanges(currentHolderIds = [], settings = getSettings()) {
  const holders = new Set(currentHolderIds);
  const eligible = new Set(
    getDb().prepare("SELECT * FROM players").all().filter((p) => isTrusted(p, settings)).map((p) => p.user_id),
  );
  return {
    gain: [...eligible].filter((id) => !holders.has(id)).sort(),
    lose: [...holders].filter((id) => !eligible.has(id)).sort(),
  };
}

// regularCustomerChanges(currentHolderIds, settings?) -> { gain: [userId], lose: [userId] }
// A regular customer has at least trusted.regularCustomerMin COMPLETED bookings and is not blacklisted.
export function regularCustomerChanges(currentHolderIds = [], settings = getSettings()) {
  const holders = new Set(currentHolderIds);
  const rows = getDb()
    .prepare(
      "SELECT customer_id FROM bookings WHERE status = 'COMPLETED' AND customer_id NOT IN (SELECT user_id FROM blacklist) GROUP BY customer_id HAVING COUNT(*) >= ?",
    )
    .all(settings.trusted.regularCustomerMin);
  const eligible = new Set(rows.map((r) => r.customer_id));
  return {
    gain: [...eligible].filter((id) => !holders.has(id)).sort(),
    lose: [...holders].filter((id) => !eligible.has(id)).sort(),
  };
}
