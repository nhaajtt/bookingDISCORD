import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { hasAttested } from "./attestations.js";
import { getAvailability, isWithin } from "./availability.js";
import { endOf, holding } from "./bookings.js";
import { getPlayer } from "./players.js";
import { isBlacklisted } from "./strikes.js";
import { MINUTE } from "./time.js";

// The waiting list: a customer who wanted a slot that was taken asks to be told if it frees up. When it does, the first person in line
// is told and the slot is held for them for a short while (waitlistHoldMin), so a cancellation goes to the person who waited
// instead of to whoever is quickest. If they do not book in time the next person is told.

const MAX_ACTIVE_PER_CUSTOMER = 5;

const row = (r) => r && { id: r.id, customerId: r.customer_id, playerId: r.player_id, game: r.game, startAt: r.start_at, durationMin: r.duration_min, createdAt: r.created_at, notifiedAt: r.notified_at, doneAt: r.done_at };

export const getEntry = (id) => row(getDb().prepare("SELECT * FROM waitlist WHERE id = ?").get(id));
export const listForCustomer = (customerId) => getDb().prepare("SELECT * FROM waitlist WHERE customer_id = ? AND done_at IS NULL ORDER BY start_at").all(customerId).map(row);

// joinWaitlist({ customerId, playerId, game, startAt, durationMin }, now, settings) -> entry
export function joinWaitlist({ customerId, playerId, game, startAt, durationMin }, now = Date.now(), settings = getSettings()) {
  if (customerId === playerId) fail("SELF_BOOKING");
  if (isBlacklisted(customerId)) fail("BLACKLISTED");
  if (!hasAttested(customerId)) fail("NOT_ATTESTED");
  const player = getPlayer(playerId);
  if (!player || player.status !== "ACTIVE") fail("PLAYER_NOT_ACTIVE");
  const offered = player.games.find((g) => g.toLowerCase() === String(game ?? "").trim().toLowerCase());
  if (!offered) fail("GAME_NOT_OFFERED");
  if (!Number.isInteger(startAt) || startAt < now + settings.minLeadMin * MINUTE) fail("TOO_SOON", { minutes: settings.minLeadMin });
  if (!Number.isInteger(durationMin) || durationMin < 30 || durationMin % 30 || durationMin > settings.maxDurationHours * 60) fail("BAD_DURATION");
  return transaction(() => {
    const db = getDb();
    if (listForCustomer(customerId).length >= MAX_ACTIVE_PER_CUSTOMER) fail("INVALID_INPUT", { message: `Bạn đang chờ ${MAX_ACTIVE_PER_CUSTOMER} chỗ rồi, hãy bỏ bớt trước khi đăng ký thêm.` });
    try {
      const info = db.prepare("INSERT INTO waitlist (customer_id, player_id, game, start_at, duration_min, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(customerId, playerId, offered, startAt, durationMin, now);
      return getEntry(Number(info.lastInsertRowid));
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) fail("INVALID_INPUT", { message: "Bạn đã đăng ký chờ khung giờ này rồi." });
      throw error;
    }
  });
}

export function leaveWaitlist(entryId, customerId, now = Date.now()) {
  return Number(getDb().prepare("UPDATE waitlist SET done_at = ? WHERE id = ? AND customer_id = ? AND done_at IS NULL").run(now, entryId, customerId).changes) > 0;
}

// A booking was made for what this person waited for: the entry is finished
export function completeWaitlist(customerId, playerId, startAt, durationMin, now = Date.now()) {
  return Number(getDb().prepare("UPDATE waitlist SET done_at = ? WHERE customer_id = ? AND player_id = ? AND start_at = ? AND duration_min = ? AND done_at IS NULL").run(now, customerId, playerId, startAt, durationMin).changes);
}

// Slots held for people who were told they are free, except for `exceptCustomerId` (who is the one they are held for)
export function waitlistHolds(playerId, now = Date.now(), settings = getSettings()) {
  return getDb()
    .prepare("SELECT * FROM waitlist WHERE player_id = ? AND done_at IS NULL AND notified_at IS NOT NULL AND notified_at + ? > ?")
    .all(playerId, settings.waitlistHoldMin * MINUTE, now)
    .map(row);
}

export function slotHeldForOthers(playerId, customerId, startAt, durationMin, now = Date.now(), settings = getSettings()) {
  const endAt = startAt + durationMin * MINUTE;
  return waitlistHolds(playerId, now, settings).some((w) => w.customerId !== customerId && w.startAt < endAt && startAt < w.startAt + w.durationMin * MINUTE);
}

// Could this slot be booked right now by anyone? (hours, other bookings, lead time and horizon; no holds)
export function slotIsFree(playerId, startAt, durationMin, now = Date.now(), settings = getSettings()) {
  const player = getPlayer(playerId);
  if (!player || player.status !== "ACTIVE") return false;
  if (startAt < now + settings.minLeadMin * MINUTE) return false;
  if (!isWithin(getAvailability(playerId), startAt, durationMin, settings.timezone)) return false;
  const endAt = startAt + durationMin * MINUTE;
  return !holding("player_id", playerId, now, settings).some((b) => b.start_at < endAt && startAt < endOf(b));
}

// dueWaitlist(now, settings) -> { notify: [entry], expire: [entry] }
//   expire  entries whose time has come or passed, whose person did not book inside their hold, or who can no longer be served
//   notify  the oldest entry per overlapping group whose slot is free and not held for someone else
export function dueWaitlist(now = Date.now(), settings = getSettings()) {
  const db = getDb();
  const active = db.prepare("SELECT * FROM waitlist WHERE done_at IS NULL ORDER BY created_at, id").all().map(row);
  const expire = [];
  const notify = [];
  const picked = [];
  for (const w of active) {
    const holdEnds = w.notifiedAt === null ? null : w.notifiedAt + settings.waitlistHoldMin * MINUTE;
    if (w.startAt < now + settings.minLeadMin * MINUTE || (holdEnds !== null && holdEnds <= now)) {
      expire.push(w);
      continue;
    }
    if (w.notifiedAt !== null) continue;
    if (!slotIsFree(w.playerId, w.startAt, w.durationMin, now, settings)) continue;
    const endAt = w.startAt + w.durationMin * MINUTE;
    const clash = [...waitlistHolds(w.playerId, now, settings), ...picked].some((o) => o.playerId === w.playerId && o.customerId !== w.customerId && o.startAt < endAt && w.startAt < o.startAt + o.durationMin * MINUTE);
    if (clash) continue;
    picked.push(w);
    notify.push(w);
  }
  return { notify, expire };
}

export function markNotified(entryId, now = Date.now()) {
  return Number(getDb().prepare("UPDATE waitlist SET notified_at = ? WHERE id = ? AND done_at IS NULL AND notified_at IS NULL").run(now, entryId).changes) > 0;
}

export function expireEntry(entryId, now = Date.now()) {
  return Number(getDb().prepare("UPDATE waitlist SET done_at = ? WHERE id = ? AND done_at IS NULL").run(now, entryId).changes) > 0;
}
