import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getPlayer } from "../domain/players.js";
import { formatVnd } from "../domain/pricing.js";
import { refreshCard } from "./cards.js";
import { postLog, mention } from "./guild.js";
import { revokeRole } from "./roles.js";
import { log } from "../log.js";

// Audit lines for staff and system actions, and what follows a strike that suspended a player.

// One line in the bookings log (#nhật-ký)
export const audit = (guild, text, users = []) => postLog(guild, "bookingsLogChannelId", text, users);

// One line in the money log (#sổ-tiền), never deleted by the bot
export const moneyLog = (guild, text, users = []) => postLog(guild, "moneyLogChannelId", text, users);

export const vnd = formatVnd;

// Section 8 of the design: the third strike suspends the player; the bot removes the role and shows the card as suspended, and
// offers staff a button to cancel the upcoming bookings (the owner decides, it is not automatic).
export async function afterStrike(guild, userId, strike, count = strike?.count) {
  if (!strike?.suspended) return false;
  const player = getPlayer(userId);
  await revokeRole(guild, userId, "player", { reason: "Tạm khoá do cảnh cáo" });
  await refreshCard(guild, userId).catch((error) => log.error("card.refresh_failed", { user: userId, after: "suspension", error }));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dp:cancelupcoming:${userId}`).setLabel("Huỷ các lịch sắp tới và hoàn tiền").setStyle(ButtonStyle.Danger),
  );
  await postLog(guild, "bookingsLogChannelId", {
    content: `Player ${player?.displayName ?? mention(userId)} bị tạm khoá do ${count ?? "nhiều"} cảnh cáo.`,
    components: [row],
  });
  return true;
}
