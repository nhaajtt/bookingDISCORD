import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { kvGet, kvSet } from "../kv.js";
import { localParts } from "./time.js";

// Numbers that show on profile cards, leaderboards and badges. Everything is computed from bookings, nothing is stored apart from the
// monthly winners, so a number can never disagree with the rest of the data.

// playerStats(userId) -> { completed, hours, repeatCustomers, reliability (0 to 100 or null), sessions }
// reliability is the share of sessions that were not lost to the player: a player no-show or a cancellation by the player after payment
export function playerStats(userId) {
  const db = getDb();
  const completed = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(duration_min), 0) AS minutes FROM bookings WHERE player_id = ? AND status = 'COMPLETED'").get(userId);
  const lost = db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE player_id = ? AND (status = 'NO_SHOW_PLAYER' OR (status = 'CANCELLED' AND cancelled_by = 'player' AND paid_at IS NOT NULL))")
    .get(userId).n;
  const repeat = db.prepare("SELECT COUNT(*) AS n FROM (SELECT customer_id FROM bookings WHERE player_id = ? AND status = 'COMPLETED' GROUP BY customer_id HAVING COUNT(*) >= 2)").get(userId).n;
  const sessions = completed.n + lost;
  return {
    completed: completed.n,
    hours: Math.round((completed.minutes / 60) * 10) / 10,
    repeatCustomers: repeat,
    sessions,
    reliability: sessions ? Math.round((completed.n / sessions) * 100) : null,
  };
}

// The three or five best players of a period: most hours played, ties broken by the average of the ratings given in the period
export function topPlayers({ from, to, limit = 5 }) {
  return getDb()
    .prepare(
      `SELECT player_id AS userId, COUNT(*) AS sessions, SUM(duration_min) / 60.0 AS hours, AVG(rating) AS average, COUNT(rating) AS rated
       FROM bookings WHERE status = 'COMPLETED' AND ended_at >= ? AND ended_at < ?
       GROUP BY player_id ORDER BY hours DESC, average DESC, sessions DESC LIMIT ?`,
    )
    .all(from, to, limit)
    .map((r) => ({ ...r, hours: Math.round(r.hours * 10) / 10, average: r.average === null ? null : Math.round(r.average * 100) / 100 }));
}

// The customers who spent the most on completed sessions in a period
export function topCustomers({ from, to, limit = 5 }) {
  return getDb()
    .prepare(
      `SELECT customer_id AS userId, COUNT(*) AS sessions, SUM(price_vnd) AS spentVnd
       FROM bookings WHERE status = 'COMPLETED' AND ended_at >= ? AND ended_at < ?
       GROUP BY customer_id ORDER BY spentVnd DESC, sessions DESC LIMIT ?`,
    )
    .all(from, to, limit)
    .map((r) => ({ ...r }));
}

// The calendar month in the server's zone: [start, end) in ms for a "YYYY-MM" key, and the key of the month before a moment
export function monthRange(key, timeZone) {
  const [y, m] = key.split("-").map(Number);
  const at = (year, month) => {
    const target = Date.UTC(year, month - 1, 1);
    let guess = target;
    for (let i = 0; i < 3; i += 1) {
      const p = localParts(guess, timeZone);
      guess -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - target;
    }
    return guess;
  };
  return { from: at(y, m), to: m === 12 ? at(y + 1, 1) : at(y, m + 1) };
}

export function monthKey(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

export function previousMonthKey(ms, timeZone) {
  const p = localParts(ms, timeZone);
  return p.month === 1 ? `${p.year - 1}-12` : `${p.year}-${String(p.month - 1).padStart(2, "0")}`;
}

// The winners of a finished month are written once, so a badge keeps showing even if bookings are corrected later
export function recordMonthlyWinners(key, settings = getSettings()) {
  const stored = kvGet(`winners:${key}`);
  if (stored) return JSON.parse(stored);
  const { from, to } = monthRange(key, settings.timezone);
  const winners = { players: topPlayers({ from, to, limit: 3 }), customers: topCustomers({ from, to, limit: 3 }) };
  kvSet(`winners:${key}`, JSON.stringify(winners));
  return winners;
}

export function winnersOf(key) {
  const stored = kvGet(`winners:${key}`);
  return stored ? JSON.parse(stored) : null;
}

// The badges of a player, as short words for the profile card
export function badgesFor(player, stats, now = Date.now(), settings = getSettings()) {
  const badges = [];
  const winners = winnersOf(previousMonthKey(now, settings.timezone));
  if (winners?.players?.some((w) => w.userId === player.userId)) badges.push("Top tháng trước");
  if (stats.hours >= 100) badges.push("100 giờ");
  else if (stats.hours >= 50) badges.push("50 giờ");
  if (stats.sessions >= 10 && stats.reliability >= 98) badges.push("Đúng giờ");
  if (stats.repeatCustomers >= 3) badges.push("Nhiều khách quay lại");
  return badges;
}
