import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { kvGet, kvSet } from "../kv.js";
import { DAY } from "./time.js";
import { fail } from "./errors.js";
import { activeStrikeCount, getBlacklistEntry } from "./strikes.js";
import { sanitizeText } from "./ratings.js";

// What staff know about a person, and the reports people send about each other. Nothing here changes a booking or any money.

export function addNote(userId, note, byUserId, now = Date.now()) {
  const text = sanitizeText(note, 500);
  if (!text) fail("INVALID_INPUT", { message: "Ghi chú không được để trống." });
  const info = getDb().prepare("INSERT INTO customer_notes (user_id, note, by_user_id, created_at) VALUES (?, ?, ?, ?)").run(userId, text, byUserId ?? null, now);
  return Number(info.lastInsertRowid);
}

export const listNotes = (userId, limit = 10) => getDb().prepare("SELECT * FROM customer_notes WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit);

export function deleteNote(noteId) {
  return Number(getDb().prepare("DELETE FROM customer_notes WHERE id = ?").run(noteId).changes) > 0;
}

const parseResolution = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

// disputeRecord(userId, now, days) -> how many disputes this person opened as a customer in the window, and how many of those
// ended with the full payout to the player (the complaint was not upheld)
export function disputeRecord(userId, now = Date.now(), days = getSettings().disputeFlagDays) {
  const rows = getDb()
    .prepare("SELECT d.*, b.customer_id FROM disputes d JOIN bookings b ON b.id = d.booking_id WHERE d.opener_id = ? AND b.customer_id = ? AND d.created_at > ?")
    .all(userId, userId, now - days * DAY);
  const rejected = rows.filter((d) => d.status === "RESOLVED" && parseResolution(d.resolution)?.outcome === "pay_player").length;
  return { opened: rows.length, rejected, open: rows.filter((d) => d.status === "OPEN").length };
}

// A customer who keeps disputing and keeps losing is a judgment call for staff, so this only raises a flag, never acts
export function disputeFlag(userId, now = Date.now(), settings = getSettings()) {
  const record = disputeRecord(userId, now, settings.disputeFlagDays);
  return { ...record, flagged: record.opened >= settings.disputeFlagCount, days: settings.disputeFlagDays };
}

// customerProfile(userId, now) -> the facts for the staff card
export function customerProfile(userId, now = Date.now(), settings = getSettings()) {
  const db = getDb();
  const byStatus = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM bookings WHERE customer_id = ? GROUP BY status").all(userId).map((r) => [r.status, r.n]));
  const spent = db.prepare("SELECT COALESCE(SUM(price_vnd), 0) AS v FROM bookings WHERE customer_id = ? AND status = 'COMPLETED'").get(userId).v;
  const last = db.prepare("SELECT MAX(start_at) AS at FROM bookings WHERE customer_id = ?").get(userId).at;
  return {
    userId,
    bookings: Object.values(byStatus).reduce((a, b) => a + b, 0),
    byStatus,
    completed: byStatus.COMPLETED ?? 0,
    cancelled: byStatus.CANCELLED ?? 0,
    spentVnd: spent,
    lastBookingAt: last ?? null,
    strikes: activeStrikeCount(userId, now, settings),
    blacklisted: getBlacklistEntry(userId),
    disputes: disputeFlag(userId, now, settings),
    notes: listNotes(userId, 5),
  };
}

// ---------------------------------------------------------------- anonymous reports

// The reporter is stored only as a hash made with a secret kept in this database, so staff cannot see who wrote a report but the
// same person is still recognised for rate limits and for refusing duplicates
function pepper() {
  let value = kvGet("report_pepper");
  if (!value) {
    value = randomBytes(24).toString("hex");
    kvSet("report_pepper", value);
  }
  return value;
}

export const reporterHash = (userId) => createHash("sha256").update(`${pepper()}:${userId}`).digest("hex").slice(0, 32);

// addReport({ reporterId, aboutUserId?, text }, now) -> report row. At most 5 reports per person per day.
export function addReport({ reporterId, aboutUserId = null, text }, now = Date.now()) {
  const clean = sanitizeText(text, 800);
  if (clean.length < 10) fail("INVALID_INPUT", { message: "Hãy mô tả rõ hơn (ít nhất 10 ký tự)." });
  if (aboutUserId && aboutUserId === reporterId) fail("INVALID_INPUT", { message: "Bạn không thể báo cáo chính mình." });
  const hash = reporterHash(reporterId);
  const db = getDb();
  const today = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE reporter_hash = ? AND created_at > ?").get(hash, now - DAY).n;
  if (today >= 5) fail("INVALID_INPUT", { message: "Bạn đã gửi nhiều báo cáo hôm nay, hãy đợi nhân viên xem xét." });
  const info = db.prepare("INSERT INTO reports (reporter_hash, about_user_id, text, created_at) VALUES (?, ?, ?, ?)").run(hash, aboutUserId, clean, now);
  return db.prepare("SELECT id, about_user_id, text, created_at, handled_at FROM reports WHERE id = ?").get(Number(info.lastInsertRowid));
}

export function handleReport(reportId, now = Date.now()) {
  return Number(getDb().prepare("UPDATE reports SET handled_at = ? WHERE id = ? AND handled_at IS NULL").run(now, reportId).changes) > 0;
}

export const reportsAbout = (userId) => getDb().prepare("SELECT COUNT(*) AS n FROM reports WHERE about_user_id = ?").get(userId).n;
