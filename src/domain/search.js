import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { getAvailability, isWithin } from "./availability.js";
import { endOf } from "./bookings.js";
import { listPlayers } from "./players.js";
import { gameRates } from "./quoting.js";
import { playerStats } from "./stats.js";
import { DAY, MINUTE } from "./time.js";

// Finding a player: filters on game, price, rating and language, "free right now", and a sort order. Pure reads, no Discord.

export const SORTS = ["diem", "gia-tang", "gia-giam", "gio", "moi"];

const STEP = 30 * MINUTE;
const nextHalfHour = (ms) => Math.ceil(ms / STEP) * STEP;

// The bookings that occupy a player's time right now or later: confirmed and running ones, and unpaid ones inside their payment window
function busy(playerId, now, settings) {
  return getDb()
    .prepare(
      `SELECT start_at, duration_min FROM bookings WHERE player_id = ? AND start_at + duration_min * 60000 > ?
       AND (status IN ('CONFIRMED','IN_PROGRESS') OR (status = 'AWAITING_PAYMENT' AND created_at + ? > ?))`,
    )
    .all(playerId, now, settings.unpaidExpireMin * MINUTE, now);
}

const overlaps = (list, startAt, endAt) => list.some((b) => b.start_at < endAt && startAt < endOf(b));

// nextFreeSlot(playerId, durationMin, now, settings) -> the first start time the player could be booked for that long, or null.
// It respects the lead time, the booking horizon, the weekly hours and the player's other bookings.
export function nextFreeSlot(playerId, durationMin = 60, now = Date.now(), settings = getSettings()) {
  const slots = getAvailability(playerId);
  if (!slots.length) return null;
  const taken = busy(playerId, now, settings);
  const last = now + settings.maxAdvanceDays * DAY;
  for (let at = nextHalfHour(now + settings.minLeadMin * MINUTE); at <= last; at += STEP) {
    if (isWithin(slots, at, durationMin, settings.timezone) && !overlaps(taken, at, at + durationMin * MINUTE)) return at;
  }
  return null;
}

// Free for the next half hour starting now: inside the weekly hours and with nothing booked on top
export function freeNow(playerId, now = Date.now(), settings = getSettings()) {
  const slots = getAvailability(playerId);
  if (!slots.length) return false;
  const start = Math.floor(now / STEP) * STEP;
  return isWithin(slots, start, 60, settings.timezone) && !overlaps(busy(playerId, now, settings), now, now + STEP);
}

// searchPlayers({ game?, maxRateVnd?, minRating?, language?, freeNow?, sort?, excludeUserId?, limit? }, now) -> players with extra fields:
//   rateVnd is the price for the searched game when one is given; average and ratingCount; hours; freeNow; nextFreeAt
export function searchPlayers({ game = null, maxRateVnd = null, minRating = null, language = null, freeNow: onlyFree = false, sort = "diem", excludeUserId = null, limit = 10 } = {}, now = Date.now(), settings = getSettings()) {
  const wantedGame = game ? String(game).trim().toLowerCase() : null;
  const wantedLanguage = language ? String(language).trim().toLowerCase() : null;
  const rows = [];
  for (const p of listPlayers({ status: "ACTIVE" })) {
    if (p.userId === excludeUserId || !getAvailability(p.userId).length) continue;
    if (wantedGame && !p.games.some((g) => g.toLowerCase() === wantedGame)) continue;
    if (wantedLanguage && !p.languages.toLowerCase().includes(wantedLanguage)) continue;
    const rateVnd = wantedGame ? (gameRates(p.userId)[wantedGame] ?? p.rateVnd) : p.rateVnd;
    if (maxRateVnd !== null && rateVnd > maxRateVnd) continue;
    if (minRating !== null && !(p.ratingCount > 0 && p.average >= minRating)) continue;
    const free = freeNow(p.userId, now, settings);
    if (onlyFree && !free) continue;
    rows.push({ ...p, rateVnd, freeNow: free, hours: playerStats(p.userId).hours });
  }
  const bySort = {
    diem: (a, b) => b.average - a.average || b.ratingCount - a.ratingCount || b.completed - a.completed,
    "gia-tang": (a, b) => a.rateVnd - b.rateVnd || b.average - a.average,
    "gia-giam": (a, b) => b.rateVnd - a.rateVnd || b.average - a.average,
    gio: (a, b) => b.hours - a.hours || b.average - a.average,
    moi: (a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0),
  };
  rows.sort(bySort[sort] ?? bySort.diem);
  return rows.slice(0, limit).map((p) => ({ ...p, nextFreeAt: p.freeNow ? now : nextFreeSlot(p.userId, 60, now, settings) }));
}
