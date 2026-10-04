import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { getPlayer, listPlayers, setProfileMessage } from "../domain/players.js";
import { formatAvailability, getAvailability } from "../domain/availability.js";
import { isTrusted } from "../domain/ratings.js";
import { gameRates } from "../domain/quoting.js";
import { badgesFor, playerStats } from "../domain/stats.js";
import { now } from "./clock.js";
import { formatVnd } from "../domain/pricing.js";
import { getSettings } from "../settings.js";
import { channelOf } from "./guild.js";
import { mentionOnly } from "./respond.js";
import { COLORS } from "./text.js";
import { log } from "../log.js";

// The profile card of a player: one message in the profiles channel that is edited in place whenever something changes.

const CARD_STATUSES = ["ACTIVE", "PAUSED", "SUSPENDED"];

export function buildCard(player, settings = getSettings()) {
  const slots = getAvailability(player.userId);
  const trusted = isTrusted(player, settings);
  const state = player.status === "PAUSED" ? "Đang nghỉ" : player.status === "SUSPENDED" ? "Tạm khoá" : slots.length ? null : "Chưa có lịch rảnh";
  const stats = playerStats(player.userId);
  const badges = [...(player.verifiedAt ? ["Đã xác minh"] : []), ...(trusted ? ["Uy tín"] : []), ...badgesFor(player, stats, now(), settings)];
  const rates = gameRates(player.userId);
  const priced = player.games.filter((g) => rates[g.toLowerCase()] !== undefined && rates[g.toLowerCase()] !== player.rateVnd);
  const embed = new EmbedBuilder()
    .setColor(player.status === "ACTIVE" && slots.length ? COLORS.ok : COLORS.warn)
    .setTitle(`${player.displayName}${badges.length ? ` | ${badges.join(" | ")}` : ""}`)
    .setDescription(player.bio || "Chưa có giới thiệu.")
    .addFields(
      { name: "Game và chủ đề", value: player.games.join(", "), inline: false },
      { name: "Giá", value: `${formatVnd(player.rateVnd)} / giờ${priced.length ? `\n${priced.map((g) => `${g}: ${formatVnd(rates[g.toLowerCase()])}`).join("\n")}` : ""}`, inline: true },
      { name: "Ngôn ngữ", value: player.languages || "Chưa ghi", inline: true },
      { name: "Đánh giá", value: player.ratingCount ? `${player.average} sao (${player.ratingCount} lượt)` : "Chưa có đánh giá", inline: true },
      { name: "Đã hoàn thành", value: `${player.completed} buổi${stats.hours ? `, ${stats.hours} giờ` : ""}`, inline: true },
      ...(stats.reliability !== null && stats.sessions >= 5 ? [{ name: "Tỉ lệ đúng hẹn", value: `${stats.reliability}%`, inline: true }] : []),
      ...(player.voiceUrl ? [{ name: "Giọng nói", value: `[Nghe thử](${player.voiceUrl})`, inline: true }] : []),
      ...(player.photos.length > 1 ? [{ name: "Thêm ảnh", value: player.photos.slice(1).map((u, i) => `[Ảnh ${i + 2}](${u})`).join(" "), inline: true }] : []),
      { name: "Lịch rảnh", value: slots.length ? formatAvailability(slots) : "Chưa nhập", inline: false },
    )
    .setFooter({ text: state ? `Trạng thái: ${state}` : `Giờ tính theo múi giờ ${settings.timezone}` });
  if (player.photos[0]) embed.setImage(player.photos[0]);
  const bookable = player.status === "ACTIVE" && slots.length > 0;
  const book = new ButtonBuilder().setCustomId(`pl:book:${player.userId}`).setLabel(bookable ? "Đặt lịch" : state ?? "Không nhận lịch").setStyle(ButtonStyle.Primary).setDisabled(!bookable);
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(book)], allowedMentions: mentionOnly() };
}

// Edits the card in place, or posts a new one when there is none or it was deleted. Returns the message, or null when nothing was posted.
export async function refreshCard(guild, userId) {
  const player = getPlayer(userId);
  if (!player || !CARD_STATUSES.includes(player.status)) return null;
  const channel = await channelOf(guild, "playersChannelId");
  if (!channel) return null;
  const payload = buildCard(player);
  if (player.profileMessageId) {
    try {
      const message = await channel.messages.fetch(player.profileMessageId);
      await message.edit(payload);
      return message;
    } catch {
      // The card was deleted by hand: post a fresh one below
    }
  }
  const message = await channel.send(payload);
  setProfileMessage(userId, message.id);
  return message;
}

export async function refreshAllCards(guild) {
  let done = 0;
  for (const p of listPlayers()) {
    if (!CARD_STATUSES.includes(p.status)) continue;
    try {
      if (await refreshCard(guild, p.userId)) done += 1;
    } catch (error) {
      log.error("card.refresh_failed", { user: p.userId, error });
    }
  }
  return done;
}
