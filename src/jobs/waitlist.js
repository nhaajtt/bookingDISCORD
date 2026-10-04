import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { dueWaitlist, expireEntry, markNotified } from "../domain/waitlist.js";
import { getPlayer } from "../domain/players.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { quoteBooking } from "../domain/quoting.js";
import { getSettings } from "../settings.js";
import { now } from "../discord/clock.js";
import { sendDm } from "../discord/guild.js";
import { durationText } from "../discord/text.js";
import { log } from "../log.js";

// Tells the people in the waiting list when the slot they asked for is free, one at a time, and lets the next one in when the person
// told did not book inside their hold.

export async function runWaitlist(client, t = now()) {
  const settings = getSettings();
  const { notify, expire } = dueWaitlist(t, settings);
  let told = 0;
  for (const w of expire) {
    try {
      expireEntry(w.id, t);
      if (w.notifiedAt !== null) await sendDm(client, w.customerId, `Thời gian giữ chỗ ${formatLocal(w.startAt, settings.timezone)} với ${getPlayer(w.playerId)?.displayName ?? "player"} đã hết, chỗ được mở lại cho người khác.`);
    } catch (error) {
      log.error("waitlist.expire_failed", { entry: w.id, error });
    }
  }
  for (const w of notify) {
    try {
      const player = getPlayer(w.playerId);
      let price = "";
      try {
        price = ` Giá ${formatVnd(quoteBooking({ player, game: w.game, startAt: w.startAt, durationMin: w.durationMin, now: t }, settings).priceVnd)}.`;
      } catch {
        price = "";
      }
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wt:book:${w.id}`).setLabel("Đặt ngay").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`wt:leave:${w.id}`).setLabel("Bỏ chờ").setStyle(ButtonStyle.Secondary),
      );
      const delivered = await sendDm(client, w.customerId, {
        content: `Có chỗ rồi! ${player?.displayName ?? "Player"} đã rảnh ${formatLocal(w.startAt, settings.timezone)}, ${durationText(w.durationMin)}, ${w.game}.${price} Chỗ được giữ cho bạn ${settings.waitlistHoldMin} phút.`,
        components: [row],
      });
      if (delivered) {
        markNotified(w.id, t);
        told += 1;
      } else {
        // Nobody can be reached by a closed DM, so the next person in line gets the chance instead
        expireEntry(w.id, t);
      }
    } catch (error) {
      log.error("waitlist.notify_failed", { entry: w.id, error });
    }
  }
  return { told, expired: expire.length };
}

export default {
  name: "waitlist",
  everyMs: 60_000,
  run: (client) => runWaitlist(client),
};
