import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { DAY } from "./time.js";

// Weekly repeats: "the same time every week for N weeks". The first booking is made and paid like any other. For every later week the
// customer is reminded three days before and presses one button, which makes that booking and its payment at that moment. Nothing is
// charged and no slot is held by the repeat itself, so a customer is never billed for a week they did not confirm.

export const REMIND_BEFORE_MS = 3 * DAY;

const row = (r) => r && { id: r.id, customerId: r.customer_id, playerId: r.player_id, game: r.game, durationMin: r.duration_min, remaining: r.remaining, active: Boolean(r.active), nextAt: r.next_at, createdAt: r.created_at };

export const getSeries = (id) => row(getDb().prepare("SELECT * FROM series WHERE id = ?").get(id));
export const listSeries = (customerId) => getDb().prepare("SELECT * FROM series WHERE customer_id = ? AND active = 1 ORDER BY next_at").all(customerId).map(row);

// createSeries({ bookingId, weeks }, now, settings) -> series. `weeks` counts the first booking, so 4 means this one and three more.
export function createSeries({ bookingId, weeks }, now = Date.now(), settings = getSettings()) {
  if (!settings.maxSeriesWeeks) fail("INVALID_INPUT", { message: "Đặt lặp hằng tuần đang tắt." });
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > settings.maxSeriesWeeks) fail("INVALID_INPUT", { message: `Số tuần lặp phải từ 2 đến ${settings.maxSeriesWeeks}.` });
  return transaction(() => {
    const db = getDb();
    const b = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!b) fail("NOT_FOUND", { what: "lịch" });
    if (b.series_id) fail("INVALID_INPUT", { message: "Lịch này đã nằm trong một chuỗi lặp." });
    const info = db
      .prepare("INSERT INTO series (customer_id, player_id, game, duration_min, weekday, start_min, remaining, active, created_at, next_at) VALUES (?, ?, ?, ?, 0, 0, ?, 1, ?, ?)")
      .run(b.customer_id, b.player_id, b.game, b.duration_min, weeks - 1, now, b.start_at + 7 * DAY);
    const id = Number(info.lastInsertRowid);
    db.prepare("UPDATE bookings SET series_id = ? WHERE id = ?").run(id, bookingId);
    return getSeries(id);
  });
}

export const stopSeries = (id, customerId) => Number(getDb().prepare("UPDATE series SET active = 0 WHERE id = ? AND customer_id = ? AND active = 1").run(id, customerId).changes) > 0;

// Series whose next week is within three days (or already past) and that were not reminded yet
export function dueSeries(now = Date.now()) {
  return getDb().prepare("SELECT * FROM series WHERE active = 1 AND remaining > 0 AND next_at - ? <= ? ORDER BY next_at").all(REMIND_BEFORE_MS, now).map(row);
}

// Moves the series on to the following week, whether the customer booked this one, skipped it or it could not be offered
export function advanceSeries(id) {
  return transaction(() => {
    const db = getDb();
    db.prepare("UPDATE series SET remaining = remaining - 1, next_at = next_at + ? WHERE id = ? AND active = 1 AND remaining > 0").run(7 * DAY, id);
    db.prepare("UPDATE series SET active = 0 WHERE id = ? AND remaining <= 0").run(id);
    return getSeries(id);
  });
}

// The week (its start time) a reminder was already sent for, so each week is offered once
export const markReminded = (id, nextAt) => getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`series_reminded:${id}`, String(nextAt));
export const lastReminded = (id) => Number(getDb().prepare("SELECT value FROM kv WHERE key = ?").get(`series_reminded:${id}`)?.value ?? 0);
