import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { listBookings } from "../domain/bookings.js";
import { getPlayer } from "../domain/players.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { defer, respond } from "../discord/respond.js";
import { mention } from "../discord/guild.js";
import { CANCELLABLE, COLORS, bookingSummary } from "../discord/text.js";
import { againButton } from "../flows/booking.js";

const SHOWN = 15;

export default {
  data: new SlashCommandBuilder().setName("lichcuatoi").setDescription("Xem các lịch của bạn").setDMPermission(false),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user");
    if (refusal) return respond(interaction, refusal);
    const userId = interaction.user.id;
    const zone = getSettings().timezone;
    const mine = [
      ...listBookings({ customerId: userId, limit: 100 }).map((b) => ({ b, side: "Khách", other: getPlayer(b.player_id)?.displayName ?? mention(b.player_id) })),
      ...listBookings({ playerId: userId, limit: 100 }).map((b) => ({ b, side: "Player", other: mention(b.customer_id) })),
    ]
      .sort((x, y) => y.b.start_at - x.b.start_at)
      .slice(0, SHOWN);
    if (!mine.length) return respond(interaction, "Bạn chưa có lịch nào. Dùng /datlich để đặt lịch.");

    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle("Lịch của bạn")
      .setDescription(mine.map(({ b, side, other }) => `${side} | ${other} | ${bookingSummary(b, zone)}`).join("\n"));
    const buttons = mine
      .filter(({ b }) => CANCELLABLE.includes(b.status))
      .slice(0, 10)
      .map(({ b }) => new ButtonBuilder().setCustomId(`bk:cancel:${b.id}`).setLabel(`Huỷ #${b.id}`).setStyle(ButtonStyle.Secondary));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    // One "book again" button per player this person has finished a session with, newest first
    const seen = new Set();
    const again = mine
      .filter(({ b, side }) => side === "Khách" && b.status === "COMPLETED" && getPlayer(b.player_id)?.status === "ACTIVE" && !seen.has(b.player_id) && seen.add(b.player_id))
      .slice(0, 5)
      .map(({ b }) => againButton(b.id, getPlayer(b.player_id).displayName));
    if (again.length) rows.push(new ActionRowBuilder().addComponents(again));
    return respond(interaction, { embeds: [embed], components: rows });
  },
};
