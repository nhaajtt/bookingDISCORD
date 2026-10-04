import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { DAY } from "./time.js";
import { activeStrikeCount, isBlacklisted } from "./strikes.js";
import { disputeRecord, reportsAbout } from "./people.js";
import { sanitizeText } from "./ratings.js";

// Trust and safety. Four small pieces that make a booking safer for both sides; none of them moves money.
//   verification   staff vouch that a player is who they say they are (a badge, set by a person, never by the bot)
//   safety alerts  a button in the room that tells staff at once
//   customer stars players rate the customer after a session, so the next player can be warned
//   risk           a plain score from facts the bot already holds, with the reasons spelled out, for staff to read

// ---------------------------------------------------------------- verification

export function verifyPlayer(userId, byUserId, now = Date.now()) {
  const changed = Number(getDb().prepare("UPDATE players SET verified_at = COALESCE(verified_at, ?), verified_by = COALESCE(verified_by, ?) WHERE user_id = ? AND status IN ('ACTIVE','PAUSED','SUSPENDED')").run(now, byUserId ?? null, userId).changes);
  if (!changed) fail("NOT_FOUND", { what: "player" });
  return getDb().prepare("SELECT verified_at FROM players WHERE user_id = ?").get(userId).verified_at;
}

export function unverifyPlayer(userId) {
  return Number(getDb().prepare("UPDATE players SET verified_at = NULL, verified_by = NULL WHERE user_id = ? AND verified_at IS NOT NULL").run(userId).changes) > 0;
}

// ---------------------------------------------------------------- safety alerts

// recordSafetyAlert(bookingId, userId, now) -> { alert, booking }. Only the two people of the booking, and only for a booking that is
// on (confirmed, running, or ended in the last day), so a stale button cannot raise an alarm about a closed case.
export function recordSafetyAlert(bookingId, userId, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (userId !== booking.customer_id && userId !== booking.player_id) fail("FORBIDDEN_ACTOR");
    const ended = booking.ended_at ?? booking.start_at + booking.duration_min * 60_000;
    const live = ["CONFIRMED", "IN_PROGRESS"].includes(booking.status) || (["COMPLETED", "DISPUTED"].includes(booking.status) && now < ended + DAY);
    if (!live) fail("ILLEGAL_TRANSITION", { status: booking.status, action: "alert" });
    const info = db.prepare("INSERT INTO safety_alerts (booking_id, user_id, created_at) VALUES (?, ?, ?)").run(bookingId, userId, now);
    return { alert: db.prepare("SELECT * FROM safety_alerts WHERE id = ?").get(Number(info.lastInsertRowid)), booking };
  });
}

export const openSafetyAlerts = () => getDb().prepare("SELECT * FROM safety_alerts WHERE handled_at IS NULL ORDER BY created_at").all();

export function handleSafetyAlert(alertId, byUserId, now = Date.now()) {
  return Number(getDb().prepare("UPDATE safety_alerts SET handled_at = ?, handled_by = ? WHERE id = ? AND handled_at IS NULL").run(now, byUserId ?? null, alertId).changes) > 0;
}

export const alertsAbout = (userId) =>
  Number(getDb().prepare("SELECT COUNT(*) AS n FROM safety_alerts a JOIN bookings b ON b.id = a.booking_id WHERE (b.customer_id = ? OR b.player_id = ?) AND a.user_id != ?").get(userId, userId, userId).n);

// ---------------------------------------------------------------- customer ratings

// rateCustomer(bookingId, playerId, stars, note, now, settings) -> { stars }. Once per booking, by that booking's player, for a
// completed session and inside the same window the customer has to rate the player.
export function rateCustomer(bookingId, playerId, stars, note = "", now = Date.now(), settings = getSettings()) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail("BAD_STARS");
  return transaction(() => {
    const db = getDb();
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (booking.player_id !== playerId) fail("FORBIDDEN_ACTOR");
    if (booking.status !== "COMPLETED") fail("INVALID_INPUT", { message: "Chỉ đánh giá được khách sau khi buổi chơi đã kết thúc." });
    if (now > (booking.ended_at ?? booking.start_at) + settings.reviewWindowHours * 3_600_000 * 7) fail("TOO_LATE");
    const made = Number(db.prepare("INSERT OR IGNORE INTO customer_ratings (booking_id, player_id, customer_id, stars, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(bookingId, playerId, booking.customer_id, stars, sanitizeText(note, 300) || null, now).changes);
    if (!made) fail("INVALID_INPUT", { message: "Bạn đã đánh giá khách của buổi này rồi." });
    return { stars, customerId: booking.customer_id };
  });
}

export function customerRating(userId) {
  const row = getDb().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS s FROM customer_ratings WHERE customer_id = ?").get(userId);
  return { count: Number(row.n), average: row.n ? Math.round((Number(row.s) / Number(row.n)) * 100) / 100 : 0 };
}

// ---------------------------------------------------------------- risk

export const RISK_LEVEL = { LOW: "Thấp", MEDIUM: "Trung bình", HIGH: "Cao" };

// customerRisk(userId, now, settings) -> { level: "LOW" | "MEDIUM" | "HIGH", points, reasons: [text] }
// A plain sum of facts, each with its reason, so staff can see why and disagree. It never blocks anything by itself.
export function customerRisk(userId, now = Date.now(), settings = getSettings()) {
  const db = getDb();
  const reasons = [];
  let points = 0;
  const add = (n, text) => {
    points += n;
    reasons.push(`${text} (+${n})`);
  };
  if (isBlacklisted(userId)) add(100, "Đang trong danh sách cấm");
  const strikes = activeStrikeCount(userId, now, settings);
  if (strikes) add(Math.min(strikes * 20, 60), `${strikes} cảnh cáo còn hiệu lực`);
  const disputes = disputeRecord(userId, now, settings.disputeFlagDays);
  if (disputes.rejected) add(Math.min(disputes.rejected * 15, 45), `${disputes.rejected} khiếu nại bị bác trong ${settings.disputeFlagDays} ngày`);
  if (disputes.opened >= settings.disputeFlagCount) add(20, `mở ${disputes.opened} khiếu nại trong ${settings.disputeFlagDays} ngày`);
  const reports = reportsAbout(userId);
  if (reports) add(Math.min(reports * 10, 30), `${reports} lần bị báo cáo`);
  const alerts = alertsAbout(userId);
  if (alerts) add(Math.min(alerts * 20, 40), `${alerts} lần người cùng buổi bấm báo khẩn`);
  const noShows = Number(db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ? AND status = 'NO_SHOW_CUSTOMER' AND start_at > ?").get(userId, now - 90 * DAY).n);
  if (noShows) add(Math.min(noShows * 15, 45), `${noShows} lần vắng mặt trong 90 ngày`);
  const rating = customerRating(userId);
  if (rating.count >= 2 && rating.average <= 2.5) add(25, `player chấm trung bình ${rating.average} sao`);
  const completed = Number(db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ? AND status = 'COMPLETED'").get(userId).n);
  if (!completed) add(10, "chưa hoàn thành buổi nào (khách mới)");
  return { level: points >= 50 ? "HIGH" : points >= 25 ? "MEDIUM" : "LOW", points, reasons };
}
