import { getDb, transaction } from "../db.js";
import { defaultSettings, getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { HOUR, MINUTE } from "./time.js";
import { REMINDER_MIN, ROOM_CLOSE_DELAY_MIN, ROOM_OPEN_LEAD_MIN } from "./constants.js";

// What should happen now, decided without touching Discord or the clock. The Discord layer runs the actions and reports the ones
// that leave no trace in the booking's status through markActionDone, so they are not due again.
//
//   state = { bookings: [booking rows], voice: { [bookingId]: [userId, ...] }, settings? }
//   dueActions(state, now) -> [{ type, bookingId, ... }]
//
// Action types and when each is due:
//   expireUnpaid   AWAITING_PAYMENT older than the payment window                       -> bookings.expireUnpaid
//   reminder24h/1h/10m  CONFIRMED, once each, only if the booking was already confirmed
//                  at that moment and the next reminder is not yet due                  -> markActionDone
//   openRooms      CONFIRMED from 10 minutes before the start until the end             -> bookings.setRooms
//   start          CONFIRMED from the start, both people are in the voice room          -> bookings.start
//   noShowCheck    CONFIRMED from start + grace, not both in voice; carries `absent`    -> bookings.noShow, or cancel when both are absent
//   autoEnd        IN_PROGRESS at start + duration                                      -> bookings.complete
//   askRating      COMPLETED without a rating, once, inside the review window           -> markActionDone
//   autoComplete   COMPLETED without a rating when the review window has closed, once   -> markActionDone (rating buttons come off, payout is releasable)
//   closeRooms     finished booking that has rooms, 15 minutes after it ended, once     -> markActionDone

export const FLAG_ACTIONS = ["reminder24h", "reminder1h", "reminder10m", "openRooms", "askRating", "autoComplete", "closeRooms"];
const ORDER = ["expireUnpaid", "reminder24h", "reminder1h", "reminder10m", "openRooms", "start", "noShowCheck", "autoEnd", "askRating", "autoComplete", "closeRooms"];
const FINISHED = ["COMPLETED", "CANCELLED", "NO_SHOW_PLAYER", "NO_SHOW_CUSTOMER"];

const flagsOf = (b) => (typeof b.reminders_sent === "string" ? JSON.parse(b.reminders_sent || "{}") : b.reminders_sent ?? {});

function present(state, booking) {
  const inRoom = new Set(state.voice?.[booking.id] ?? []);
  return { customer: inRoom.has(booking.customer_id), player: inRoom.has(booking.player_id) };
}

export function dueActions(state, now) {
  const settings = state.settings ?? defaultSettings();
  const out = [];
  for (const b of state.bookings ?? []) {
    const flags = flagsOf(b);
    const end = b.start_at + b.duration_min * MINUTE;
    const add = (type, extra = {}) => out.push({ type, bookingId: b.id, ...extra });

    if (b.status === "AWAITING_PAYMENT" && now >= b.created_at + settings.unpaidExpireMin * MINUTE) add("expireUnpaid");

    if (b.status === "CONFIRMED") {
      const confirmedAt = b.paid_at ?? b.created_at;
      const remind = [
        ["reminder24h", REMINDER_MIN.reminder24h, REMINDER_MIN.reminder1h],
        ["reminder1h", REMINDER_MIN.reminder1h, REMINDER_MIN.reminder10m],
        ["reminder10m", REMINDER_MIN.reminder10m, 0],
      ];
      for (const [type, before, nextBefore] of remind) {
        const at = b.start_at - before * MINUTE;
        const staleAt = b.start_at - nextBefore * MINUTE;
        if (!flags[type] && now >= at && now < staleAt && confirmedAt <= at) add(type);
      }
      if (!flags.openRooms && now >= b.start_at - ROOM_OPEN_LEAD_MIN * MINUTE && now < end) add("openRooms");
      const here = present(state, b);
      if (now >= b.start_at && now < end && here.customer && here.player) add("start");
      if (now >= b.start_at + settings.noShowGraceMin * MINUTE && !(here.customer && here.player)) {
        add("noShowCheck", { absent: !here.customer && !here.player ? "both" : here.customer ? "player" : "customer" });
      }
    }

    if (b.status === "IN_PROGRESS" && now >= end) add("autoEnd");

    if (b.status === "COMPLETED" && b.rating === null && b.ended_at !== null) {
      const closesAt = b.ended_at + settings.reviewWindowHours * HOUR;
      if (!flags.askRating && now >= b.ended_at && now < closesAt) add("askRating");
      if (!flags.autoComplete && now >= closesAt) add("autoComplete");
    }

    const hasRooms = Boolean(b.text_channel_id || b.voice_channel_id);
    if (hasRooms && FINISHED.includes(b.status) && b.ended_at !== null && !flags.closeRooms && now >= b.ended_at + ROOM_CLOSE_DELAY_MIN * MINUTE) add("closeRooms");
  }
  return out.sort((a, b) => a.bookingId - b.bookingId || ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
}

// Loads what dueActions needs from the database: every booking that is still going, plus finished ones recent enough to have
// rooms to close or a rating to ask for. `voice` is supplied by the Discord layer (who is in each booking's voice room).
export function loadScheduleState(now, voice = {}, settings = getSettings()) {
  const since = now - (settings.reviewWindowHours + 48) * HOUR;
  const bookings = getDb()
    .prepare(
      `SELECT * FROM bookings WHERE status IN ('AWAITING_PAYMENT','CONFIRMED','IN_PROGRESS') OR (ended_at IS NOT NULL AND ended_at >= ?) ORDER BY id`,
    )
    .all(since);
  return { bookings, voice, settings };
}

// markActionDone(bookingId, type, now) -> true if this call recorded it, false if it was already recorded
export function markActionDone(bookingId, type, now = Date.now()) {
  if (!FLAG_ACTIONS.includes(type)) fail("INVALID_INPUT", { message: `Hành động ${type} không cần đánh dấu.` });
  return transaction(() => {
    const row = getDb().prepare("SELECT reminders_sent FROM bookings WHERE id = ?").get(bookingId);
    if (!row) fail("NOT_FOUND", { what: "lịch" });
    const flags = JSON.parse(row.reminders_sent || "{}");
    if (flags[type]) return false;
    flags[type] = now;
    getDb().prepare("UPDATE bookings SET reminders_sent = ? WHERE id = ?").run(JSON.stringify(flags), bookingId);
    return true;
  });
}
