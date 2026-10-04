import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { getAvailability, isWithin } from "./availability.js";
import { endOf, getBooking, holding } from "./bookings.js";
import { getPlayer } from "./players.js";
import { quoteBooking } from "./quoting.js";
import { pendingExtensions } from "../pay/orders.js";
import { DURATION_STEP_MIN } from "./pricing.js";
import { MINUTE } from "./time.js";

// Buying more time inside a session that is running. The extension is added to the same booking: its duration, price and fee grow, so
// the ledger, the payout, the refund rules and the end of the session all follow without any special case. It is only offered when
// the player is free for those minutes, and the minutes are held while the customer pays.

const refuse = (message) => fail("NOT_EXTENDABLE", { message });

// quoteExtension(bookingId, extraMin, now, settings) -> { booking, extraMin, priceVnd, feeVnd, newEndAt }
export function quoteExtension(bookingId, extraMin, now = Date.now(), settings = getSettings()) {
  const booking = getBooking(bookingId);
  if (!booking) fail("NOT_FOUND", { what: "lịch" });
  if (!settings.maxExtendMin) refuse("Tính năng gia hạn đang tắt.");
  if (booking.status !== "IN_PROGRESS") refuse("Chỉ gia hạn được khi buổi đang diễn ra.");
  if (!Number.isInteger(extraMin) || extraMin < DURATION_STEP_MIN || extraMin % DURATION_STEP_MIN) refuse(`Thời gian thêm phải là bội số của ${DURATION_STEP_MIN} phút.`);
  if (booking.extended_min + extraMin > settings.maxExtendMin) refuse(`Mỗi buổi chỉ gia hạn thêm tối đa ${settings.maxExtendMin} phút (đã thêm ${booking.extended_min} phút).`);
  if (booking.duration_min + extraMin > settings.maxDurationHours * 60) refuse(`Một buổi dài tối đa ${settings.maxDurationHours} giờ.`);
  const end = endOf(booking);
  if (now >= end) refuse("Buổi này đã hết giờ.");
  const newEnd = end + extraMin * MINUTE;
  const player = getPlayer(booking.player_id);
  if (!player || player.status !== "ACTIVE") refuse("Player này hiện không nhận thêm giờ.");
  if (!isWithin(getAvailability(booking.player_id), end, extraMin, settings.timezone)) refuse("Player không rảnh thêm trong khoảng giờ này.");
  const clash = (list) => list.some((b) => b.id !== booking.id && b.start_at < newEnd && end < endOf(b));
  if (clash(holding("player_id", booking.player_id, now, settings)) || pendingExtensions(booking.player_id, now).some((h) => h.start_at < newEnd && end < h.end_at && h.start_at !== end)) refuse("Player có lịch khác ngay sau buổi này.");
  if (clash(holding("customer_id", booking.customer_id, now, settings))) refuse("Bạn có lịch khác ngay sau buổi này.");
  const priced = quoteBooking({ player, game: booking.game, startAt: end, durationMin: extraMin, now }, settings);
  return { booking, extraMin, priceVnd: priced.priceVnd, feeVnd: priced.feeVnd, newEndAt: newEnd };
}

// applyExtension(bookingId, extraMin, priceVnd, feeVnd, now) -> the booking, longer. Throws NOT_EXTENDABLE when the session is no
// longer running (the caller then refunds what was paid).
export function applyExtension(bookingId, extraMin, priceVnd, feeVnd, now = Date.now()) {
  return transaction(() => {
    const booking = getBooking(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (booking.status !== "IN_PROGRESS" || now >= endOf(booking)) refuse("Buổi này không còn gia hạn được.");
    const changed = Number(
      getDb()
        .prepare("UPDATE bookings SET duration_min = duration_min + ?, price_vnd = price_vnd + ?, fee_vnd = fee_vnd + ?, list_price_vnd = COALESCE(list_price_vnd, price_vnd + discount_vnd) + ?, extended_min = extended_min + ? WHERE id = ? AND status = 'IN_PROGRESS'")
        .run(extraMin, priceVnd, feeVnd, priceVnd, extraMin, bookingId).changes,
    );
    if (!changed) refuse("Buổi này không còn gia hạn được.");
    return getBooking(bookingId);
  });
}
