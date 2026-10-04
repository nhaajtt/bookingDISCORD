import { listBookings, SYSTEM } from "../domain/bookings.js";
import { clearPlayerLeft, getPlayer, markPlayerLeft } from "../domain/players.js";
import { formatVnd } from "../domain/pricing.js";
import { cancelAndNotify } from "../flows/booking.js";
import { now } from "./clock.js";
import { postLog, mention, sendDm } from "./guild.js";
import { refreshCard } from "./cards.js";
import { revokeRole } from "./roles.js";
import { log } from "../log.js";

// A player who left the server (found by an Unknown Member answer, since the bot has no members intent) cannot be booked and cannot
// show up. The player is paused, the bookings that have not started are cancelled with a full refund, and the owner is told.

export async function handlePlayerLeft(client, guild, userId) {
  const player = getPlayer(userId);
  if (!player || !markPlayerLeft(userId, now())) return { paused: false, cancelled: 0, refundedVnd: 0 };
  await revokeRole(guild, userId, "player", { reason: "Player đã rời server" }).catch(() => {});
  await refreshCard(guild, userId).catch((error) => log.error("card.refresh_failed", { user: userId, after: "departure", error }));
  let cancelled = 0;
  let refundedVnd = 0;
  for (const booking of listBookings({ playerId: userId, statuses: ["AWAITING_PAYMENT", "CONFIRMED"], from: now() })) {
    try {
      const result = await cancelAndNotify(guild, client, booking.id, SYSTEM, "player đã rời server");
      cancelled += 1;
      refundedVnd += result.refundVnd;
    } catch (error) {
      log.error("departure.cancel_failed", { booking: booking.id, error });
    }
  }
  await postLog(guild, "bookingsLogChannelId", `Player ${player.displayName} (${mention(userId)}) đã rời server nên bị chuyển sang nghỉ.${cancelled ? ` Đã huỷ ${cancelled} lịch sắp tới, ghi nợ hoàn ${formatVnd(refundedVnd)} cho khách.` : ""}`);
  return { paused: true, cancelled, refundedVnd };
}

// A player marked as left who is on the server again: the mark is removed and they are asked to resume on their own
export async function handlePlayerBack(client, userId) {
  if (!clearPlayerLeft(userId)) return false;
  await sendDm(client, userId, "Chào mừng bạn quay lại! Hồ sơ player của bạn đang ở trạng thái nghỉ, dùng /player nhan-lai khi muốn nhận lịch.");
  return true;
}
