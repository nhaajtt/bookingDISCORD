import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { DAY, MINUTE, localParts } from "./time.js";
import { ROOM_OPEN_LEAD_MIN } from "./constants.js";
import { isWithin, getAvailability } from "./availability.js";
import { quoteBooking } from "./quoting.js";
import { redeemCoupon, releaseCoupon } from "./coupons.js";
import { pendingExtensions } from "../pay/orders.js";
import { completeWaitlist, slotHeldForOthers } from "./waitlist.js";
import { refundFor } from "./policy.js";
import { settleBooking, refundLatePayment, rowsFor } from "./ledger.js";
import { addStrike, clearStrikesForBooking, isBlacklisted } from "./strikes.js";
import { hasAttested } from "./attestations.js";
import { getPlayer } from "./players.js";
import { sanitizeText } from "./ratings.js";

// Booking lifecycle. Every status change goes through TRANSITIONS, which says from which status, by which kind of actor, and to where.
// Anything else throws ILLEGAL_TRANSITION. Money is written in the same database transaction as the status change, and the status
// change itself is a compare-and-swap, so a transition that runs twice (a double click, two jobs) cannot write money twice.

export const STATUS = Object.freeze({
  AWAITING_PAYMENT: "AWAITING_PAYMENT",
  CONFIRMED: "CONFIRMED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  NO_SHOW_PLAYER: "NO_SHOW_PLAYER",
  NO_SHOW_CUSTOMER: "NO_SHOW_CUSTOMER",
  DISPUTED: "DISPUTED",
  EXPIRED: "EXPIRED",
});

// Roles of whoever causes a transition: customer and player are checked against the booking, staff is anyone the Discord layer
// verified as staff, system is the bot itself (payments, scheduler).
export const TRANSITIONS = Object.freeze(
  [
    { action: "pay", from: ["AWAITING_PAYMENT"], to: "CONFIRMED", actors: ["system"] },
    { action: "expire", from: ["AWAITING_PAYMENT"], to: "EXPIRED", actors: ["system"] },
    { action: "start", from: ["CONFIRMED"], to: "IN_PROGRESS", actors: ["system", "staff"] },
    { action: "complete", from: ["IN_PROGRESS"], to: "COMPLETED", actors: ["system", "staff"] },
    { action: "cancel", from: ["AWAITING_PAYMENT", "CONFIRMED"], to: "CANCELLED", actors: ["customer", "player", "staff", "system"] },
    { action: "cancel", from: ["IN_PROGRESS"], to: "CANCELLED", actors: ["staff"] },
    { action: "noShowPlayer", from: ["CONFIRMED"], to: "NO_SHOW_PLAYER", actors: ["system", "staff"] },
    { action: "noShowCustomer", from: ["CONFIRMED"], to: "NO_SHOW_CUSTOMER", actors: ["system", "staff"] },
    { action: "dispute", from: ["IN_PROGRESS", "COMPLETED", "NO_SHOW_PLAYER", "NO_SHOW_CUSTOMER"], to: "DISPUTED", actors: ["customer", "player", "staff"] },
  ].map((rule) => Object.freeze({ ...rule, from: Object.freeze(rule.from), actors: Object.freeze(rule.actors) })),
);

export function canTransition(from, action, role) {
  return TRANSITIONS.find((r) => r.action === action && r.from.includes(from) && r.actors.includes(role)) ?? null;
}

export const SYSTEM = Object.freeze({ role: "system" });
export const staffActor = (userId) => ({ role: "staff", userId });

// The actor for a person who clicked something about this booking: staff first, then customer, then player; anyone else is refused
export function actorFor(booking, userId, { isStaff = false } = {}) {
  if (isStaff) return staffActor(userId);
  if (userId === booking.customer_id) return { role: "customer", userId };
  if (userId === booking.player_id) return { role: "player", userId };
  return fail("FORBIDDEN_ACTOR");
}

const parse = (r) => (r ? { ...r, reminders_sent: JSON.parse(r.reminders_sent || "{}") } : null);
export const endOf = (b) => b.start_at + b.duration_min * MINUTE;

export function getBooking(id) {
  return parse(getDb().prepare("SELECT * FROM bookings WHERE id = ?").get(id));
}

function mustGet(id) {
  const booking = getBooking(id);
  if (!booking) fail("NOT_FOUND", { what: "lịch" });
  return booking;
}

// listBookings({ customerId?, playerId?, statuses?, from?, to?, limit? }) -> bookings ordered by start time
export function listBookings({ customerId = null, playerId = null, statuses = null, from = null, to = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (customerId) (where.push("customer_id = ?"), params.push(customerId));
  if (playerId) (where.push("player_id = ?"), params.push(playerId));
  if (statuses?.length) (where.push(`status IN (${statuses.map(() => "?").join(",")})`), params.push(...statuses));
  if (from !== null) (where.push("start_at >= ?"), params.push(from));
  if (to !== null) (where.push("start_at < ?"), params.push(to));
  const sql = `SELECT * FROM bookings ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY start_at, id LIMIT ?`;
  return getDb().prepare(sql).all(...params, limit).map(parse);
}

// Bookings that occupy a person's time: confirmed and running ones, and unpaid ones whose payment window is still open
export function holding(column, userId, now, settings) {
  return getDb()
    .prepare(
      `SELECT * FROM bookings WHERE ${column} = ? AND (status IN ('CONFIRMED','IN_PROGRESS') OR (status = 'AWAITING_PAYMENT' AND created_at + ? > ?))`,
    )
    .all(userId, settings.unpaidExpireMin * MINUTE, now)
    .map(parse);
}

const overlaps = (a, startAt, endAt) => a.start_at < endAt && startAt < endOf(a);

// createBooking({ customerId, playerId, game, startAt, durationMin }, now, settings?) -> booking (AWAITING_PAYMENT)
// The checks run in a fixed order and each failure has its own error code; see the messages in errors.js. An unpaid booking holds
// the player's slot for the payment window, so two customers cannot both be told the slot is theirs.
export function createBooking({ customerId, playerId, game, startAt, durationMin, couponCode = null, seriesId = null }, now = Date.now(), settings = getSettings()) {
  if (customerId === playerId) fail("SELF_BOOKING");
  if (isBlacklisted(customerId) || isBlacklisted(playerId)) fail("BLACKLISTED");
  if (!hasAttested(customerId)) fail("NOT_ATTESTED");
  const player = getPlayer(playerId);
  if (!player) fail("NOT_FOUND", { what: "player" });
  if (player.status !== "ACTIVE") fail("PLAYER_NOT_ACTIVE");
  const wanted = String(game ?? "").trim().toLowerCase();
  const offered = player.games.find((g) => g.toLowerCase() === wanted);
  if (!offered) fail("GAME_NOT_OFFERED");

  if (!Number.isFinite(startAt) || !Number.isInteger(startAt)) fail("BAD_START");
  const local = localParts(startAt, settings.timezone);
  if (local.minute % 30 || local.second || startAt % 1000) fail("BAD_START");
  if (startAt <= now) fail("IN_PAST");
  if (startAt < now + settings.minLeadMin * MINUTE) fail("TOO_SOON", { minutes: settings.minLeadMin });
  if (startAt > now + settings.maxAdvanceDays * DAY) fail("TOO_FAR", { days: settings.maxAdvanceDays });
  if (!isWithin(getAvailability(playerId), startAt, durationMin, settings.timezone)) fail("OUTSIDE_AVAILABILITY");
  // The price comes from the player's rate for this game, peak hours and the coupon; only the duration is held to the owner's limits
  const priced = quoteBooking({ player, game: offered, startAt, durationMin, couponCode, userId: customerId, now }, settings);

  return transaction(() => {
    const endAt = startAt + durationMin * MINUTE;
    if (holding("player_id", playerId, now, settings).some((b) => overlaps(b, startAt, endAt))) fail("PLAYER_BUSY");
    if (slotHeldForOthers(playerId, customerId, startAt, durationMin, now, settings)) fail("SLOT_HELD");
    // Minutes that a customer is paying to add to a running session are not free for anyone else
    if (pendingExtensions(playerId, now).some((h) => h.start_at < endAt && startAt < h.end_at)) fail("PLAYER_BUSY");
    const mine = holding("customer_id", customerId, now, settings);
    if (mine.some((b) => overlaps(b, startAt, endAt))) fail("CUSTOMER_BUSY");
    if (mine.length >= settings.maxActiveBookings) fail("TOO_MANY_ACTIVE", { max: settings.maxActiveBookings });
    const info = getDb()
      .prepare(
        "INSERT INTO bookings (customer_id, player_id, game, start_at, duration_min, price_vnd, fee_vnd, status, created_at, list_price_vnd, discount_vnd, coupon_code, series_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'AWAITING_PAYMENT', ?, ?, ?, ?, ?)",
      )
      .run(customerId, playerId, offered, startAt, durationMin, priced.priceVnd, priced.feeVnd, now, priced.listPriceVnd, priced.discountVnd, priced.coupon?.code ?? null, seriesId);
    const bookingId = Number(info.lastInsertRowid);
    completeWaitlist(customerId, playerId, startAt, durationMin, now);
    if (priced.coupon) redeemCoupon(bookingId, priced.coupon.code, customerId, priced.discountVnd, now);
    return mustGet(bookingId);
  });
}

// Finds the rule for (status, action) and checks who is acting
function authorize(booking, action, actor) {
  const rule = TRANSITIONS.find((r) => r.action === action && r.from.includes(booking.status));
  if (!rule) fail("ILLEGAL_TRANSITION", { status: booking.status, action });
  if (!rule.actors.includes(actor?.role)) fail("FORBIDDEN_ACTOR");
  if (actor.role === "customer" && actor.userId !== booking.customer_id) fail("FORBIDDEN_ACTOR");
  if (actor.role === "player" && actor.userId !== booking.player_id) fail("FORBIDDEN_ACTOR");
  return rule;
}

// Compare-and-swap on the status: a second caller that lost the race finds the status already moved and fails
function swap(booking, to, fields = {}) {
  const names = Object.keys(fields);
  const sql = `UPDATE bookings SET status = ?${names.map((n) => `, ${n} = ?`).join("")} WHERE id = ? AND status = ?`;
  const changed = Number(getDb().prepare(sql).run(to, ...names.map((n) => fields[n]), booking.id, booking.status).changes);
  if (!changed) fail("ILLEGAL_TRANSITION", { status: getBooking(booking.id)?.status, action: to });
  return mustGet(booking.id);
}

function slotTakenByOthers(booking, now, settings) {
  const endAt = endOf(booking);
  return (
    holding("player_id", booking.player_id, now, settings).some((b) => b.id !== booking.id && overlaps(b, booking.start_at, endAt)) ||
    holding("customer_id", booking.customer_id, now, settings).some((b) => b.id !== booking.id && overlaps(b, booking.start_at, endAt)) ||
    pendingExtensions(booking.player_id, now).some((h) => h.start_at < endAt && booking.start_at < h.end_at)
  );
}

// pay(bookingId, now, amountPaid?) -> { booking, late, refundVnd }
// AWAITING_PAYMENT -> CONFIRMED. Money that arrives after the booking expired or was cancelled unpaid is not lost: it becomes a
// REFUND row (late: true). Paying a booking that was already paid is an illegal transition.
export function pay(bookingId, now = Date.now(), amountPaid = null, settings = getSettings()) {
  return transaction(() => {
    const booking = mustGet(bookingId);
    if (booking.status === "AWAITING_PAYMENT") {
      if (amountPaid !== null && amountPaid < booking.price_vnd) fail("UNDERPAID");
      // After the payment window the slot may have been given to someone else: then the money is refunded like any late payment
      if (now >= booking.created_at + settings.unpaidExpireMin * MINUTE && slotTakenByOthers(booking, now, settings)) {
        swap(booking, "EXPIRED", { ended_at: now });
        releaseCoupon(bookingId, now);
        const refundVnd = amountPaid ?? booking.price_vnd;
        refundLatePayment(bookingId, refundVnd, now);
        return { booking: mustGet(bookingId), late: true, refundVnd };
      }
      return { booking: swap(booking, "CONFIRMED", { paid_at: now }), late: false, refundVnd: 0 };
    }
    if ((booking.status === "EXPIRED" || booking.status === "CANCELLED") && booking.paid_at === null) {
      const refundVnd = amountPaid ?? booking.price_vnd;
      refundLatePayment(bookingId, refundVnd, now);
      return { booking: mustGet(bookingId), late: true, refundVnd };
    }
    return fail("ILLEGAL_TRANSITION", { status: booking.status, action: "pay" });
  });
}

// expireUnpaid(bookingId, now, settings?): AWAITING_PAYMENT -> EXPIRED once the payment window has passed
export function expireUnpaid(bookingId, now = Date.now(), settings = getSettings()) {
  return transaction(() => {
    const booking = mustGet(bookingId);
    authorize(booking, "expire", SYSTEM);
    if (now < booking.created_at + settings.unpaidExpireMin * MINUTE) fail("TOO_EARLY");
    const expired = swap(booking, "EXPIRED", { ended_at: now });
    releaseCoupon(bookingId, now);
    return expired;
  });
}

// start(bookingId, actor, now): CONFIRMED -> IN_PROGRESS, from the moment the rooms open until the session would have ended
export function start(bookingId, actor = SYSTEM, now = Date.now()) {
  return transaction(() => {
    const booking = mustGet(bookingId);
    authorize(booking, "start", actor);
    if (now < booking.start_at - ROOM_OPEN_LEAD_MIN * MINUTE) fail("TOO_EARLY");
    if (now >= endOf(booking)) fail("TOO_LATE");
    return swap(booking, "IN_PROGRESS", { started_at: now });
  });
}

// complete(bookingId, actor, now): IN_PROGRESS -> COMPLETED. The system may only end a session at its scheduled end; staff may end it
// sooner. The customer's payment is split into fee and player payout, and the player's completed count goes up.
export function complete(bookingId, actor = SYSTEM, now = Date.now()) {
  return transaction(() => {
    const booking = mustGet(bookingId);
    authorize(booking, "complete", actor);
    const end = endOf(booking);
    if (actor.role === "system" && now < end) fail("TOO_EARLY");
    const done = swap(booking, "COMPLETED", { ended_at: Math.min(now, end) });
    settleBooking(bookingId, 0, now);
    getDb().prepare("UPDATE players SET completed = completed + 1 WHERE user_id = ?").run(booking.player_id);
    return done;
  });
}

// cancel(bookingId, actor, now, { reason? }, settings?) -> { booking, refundVnd, percent, strike }
// Refund comes from policy.refundFor. A customer cannot cancel once the no-show grace has passed; that path is noShow or dispute.
export function cancel(bookingId, actor, now = Date.now(), { reason = null } = {}, settings = getSettings()) {
  return transaction(() => {
    const booking = mustGet(bookingId);
    authorize(booking, "cancel", actor);
    if ((actor.role === "customer" || actor.role === "player") && now >= booking.start_at + settings.noShowGraceMin * MINUTE) fail("TOO_LATE");
    const decision = refundFor(booking, actor.role, now, settings.cancellation);
    const cancelled = swap(booking, "CANCELLED", { cancelled_by: actor.role, ended_at: now });
    if (booking.status === "AWAITING_PAYMENT") releaseCoupon(bookingId, now);
    if (booking.status !== "AWAITING_PAYMENT") settleBooking(bookingId, decision.refundVnd, now, { note: reason });
    let strike = null;
    if (actor.role === "player" && booking.status === "CONFIRMED") strike = addStrike(booking.player_id, bookingId, "player_cancel", now, settings);
    return { booking: mustGet(cancelled.id), refundVnd: decision.refundVnd, percent: decision.percent, strike };
  });
}

// noShow(bookingId, side, actor, now, settings?) -> { booking, refundVnd, strike }
// side is "player" or "customer", allowed once the grace period after the start has passed. A player no-show refunds everything and
// earns the player a strike; a customer no-show pays the player as for a completed session and earns the customer a strike.
export function noShow(bookingId, side, actor = SYSTEM, now = Date.now(), settings = getSettings()) {
  if (side !== "player" && side !== "customer") fail("INVALID_INPUT", { message: "side phải là player hoặc customer." });
  return transaction(() => {
    const booking = mustGet(bookingId);
    authorize(booking, side === "player" ? "noShowPlayer" : "noShowCustomer", actor);
    if (now < booking.start_at + settings.noShowGraceMin * MINUTE) fail("TOO_EARLY");
    const refundVnd = side === "player" ? booking.price_vnd : 0;
    const updated = swap(booking, side === "player" ? "NO_SHOW_PLAYER" : "NO_SHOW_CUSTOMER", { ended_at: now });
    settleBooking(bookingId, refundVnd, now, { note: `no-show ${side}` });
    const struck = side === "player" ? booking.player_id : booking.customer_id;
    const strike = addStrike(struck, bookingId, `no_show_${side}`, now, settings);
    return { booking: mustGet(updated.id), refundVnd, strike };
  });
}

export function getDispute(id) {
  return getDb().prepare("SELECT * FROM disputes WHERE id = ?").get(id) ?? null;
}

export function listOpenDisputes() {
  return getDb().prepare("SELECT * FROM disputes WHERE status = 'OPEN' ORDER BY created_at, id").all();
}

// openDispute(bookingId, actor, reason, now, settings?) -> { booking, dispute }
// Customers and players have the review window after the end to complain; staff may at any time. The money rows stay as they are
// until staff resolve the dispute, and nothing about the booking can be paid out meanwhile.
export function openDispute(bookingId, actor, reason, now = Date.now(), settings = getSettings()) {
  const text = sanitizeText(reason, 500);
  if (!text) fail("INVALID_INPUT", { message: "Cần mô tả vấn đề." });
  return transaction(() => {
    const booking = mustGet(bookingId);
    authorize(booking, "dispute", actor);
    if (actor.role !== "staff" && booking.ended_at !== null && now > booking.ended_at + settings.reviewWindowHours * 3_600_000) fail("TOO_LATE");
    const updated = swap(booking, "DISPUTED");
    const info = getDb().prepare("INSERT INTO disputes (booking_id, opener_id, reason, status, created_at) VALUES (?, ?, ?, 'OPEN', ?)").run(bookingId, actor.userId ?? "system", text, now);
    return { booking: updated, dispute: getDispute(Number(info.lastInsertRowid)) };
  });
}

export const DISPUTE_OUTCOMES = Object.freeze(["pay_player", "refund_customer", "split"]);

export function parseResolution(dispute) {
  try {
    return dispute.resolution ? JSON.parse(dispute.resolution) : null;
  } catch {
    return null;
  }
}

// resolveDispute(disputeId, outcome, staffId, note, now, { percent?, strike?, clearStrikes? }) -> { dispute, refundVnd, rows }
// outcome is pay_player (player gets paid as for a completed session), refund_customer (full refund, no payout) or split
// (percent of the price refunded, default 50, the rest shared like any kept amount). `strike` may be "player" or "customer" to record
// a strike against the side at fault; `clearStrikes` removes the strikes this booking caused earlier (for example a no-show verdict
// that turned out wrong). Resolving twice is refused.
export function resolveDispute(disputeId, outcome, staffId, note = "", now = Date.now(), { percent = 50, strike = null, clearStrikes = false } = {}, settings = getSettings()) {
  if (!DISPUTE_OUTCOMES.includes(outcome)) fail("INVALID_INPUT", { message: "Kết quả xử lý không hợp lệ." });
  if (outcome === "split" && (!Number.isInteger(percent) || percent < 1 || percent > 99)) fail("INVALID_INPUT", { message: "Phần trăm hoàn phải từ 1 đến 99." });
  return transaction(() => {
    const dispute = getDispute(disputeId);
    if (!dispute) fail("NOT_FOUND", { what: "khiếu nại" });
    if (dispute.status !== "OPEN") fail("ILLEGAL_TRANSITION", { status: dispute.status, action: "resolve" });
    const booking = mustGet(dispute.booking_id);
    const refundVnd = outcome === "pay_player" ? 0 : outcome === "refund_customer" ? booking.price_vnd : Math.floor((booking.price_vnd * percent) / 100);
    const text = sanitizeText(note, 500);
    settleBooking(booking.id, refundVnd, now, { replace: true, note: `khiếu nại #${disputeId}` });
    const resolution = JSON.stringify({ outcome, percent: outcome === "split" ? percent : null, note: text });
    const changed = Number(
      getDb().prepare("UPDATE disputes SET status = 'RESOLVED', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'OPEN'").run(resolution, staffId, now, disputeId).changes,
    );
    if (!changed) fail("ILLEGAL_TRANSITION", { status: "RESOLVED", action: "resolve" });
    if (clearStrikes) clearStrikesForBooking(booking.id, now);
    if (strike === "player") addStrike(booking.player_id, booking.id, "dispute_lost", now, settings);
    if (strike === "customer") addStrike(booking.customer_id, booking.id, "dispute_lost", now, settings);
    return { dispute: getDispute(disputeId), refundVnd, rows: rowsFor(booking.id) };
  });
}

// setRooms(bookingId, textChannelId, voiceChannelId, now): remembers the private rooms and records that they were opened
export function setRooms(bookingId, textChannelId, voiceChannelId, now = Date.now()) {
  return transaction(() => {
    const booking = mustGet(bookingId);
    const flags = { ...booking.reminders_sent, openRooms: now };
    getDb().prepare("UPDATE bookings SET text_channel_id = ?, voice_channel_id = ?, reminders_sent = ? WHERE id = ?").run(textChannelId, voiceChannelId, JSON.stringify(flags), bookingId);
    return mustGet(bookingId);
  });
}

// Staff tool for a suspended or leaving player: cancels every booking that has not started yet, each with a full refund
export function cancelUpcomingForPlayer(playerId, actor, now = Date.now()) {
  const upcoming = listBookings({ playerId, statuses: ["AWAITING_PAYMENT", "CONFIRMED"], from: now });
  return upcoming.map((b) => cancel(b.id, actor, now, { reason: "player không còn nhận lịch" }));
}
