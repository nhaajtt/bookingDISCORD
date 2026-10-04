import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { getPlayer } from "../domain/players.js";
import { formatVnd } from "../domain/pricing.js";
import { monthKey, monthRange, previousMonthKey, recordMonthlyWinners, topCustomers, topPlayers } from "../domain/stats.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { mention } from "../discord/guild.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

// The leaderboard: the players who played the most hours and the customers who spent the most, for this month so far or for last month.
// Only names and totals are shown; nothing about who booked whom.

const MEDALS = ["1.", "2.", "3.", "4.", "5."];

export function leaderboardEmbed({ title, players, customers }) {
  const embed = new EmbedBuilder().setColor(COLORS.ok).setTitle(title);
  embed.addFields(
    {
      name: "Player chơi nhiều giờ nhất",
      value: players.length ? players.map((p, i) => `${MEDALS[i]} ${getPlayer(p.userId)?.displayName ?? mention(p.userId)}: ${p.hours} giờ, ${p.sessions} buổi${p.average ? `, ${p.average} sao` : ""}`).join("\n") : "Chưa có buổi nào hoàn thành.",
    },
    {
      name: "Khách chi nhiều nhất",
      value: customers.length ? customers.map((c, i) => `${MEDALS[i]} ${mention(c.userId)}: ${formatVnd(c.spentVnd)}, ${c.sessions} buổi`).join("\n") : "Chưa có buổi nào hoàn thành.",
    },
  );
  return embed;
}

export default {
  data: new SlashCommandBuilder()
    .setName("bangxephang")
    .setDescription("Bảng xếp hạng player và khách trong tháng")
    .setDMPermission(false)
    .addStringOption((o) => o.setName("thang").setDescription("Tháng nào").addChoices({ name: "Tháng này (đến hiện tại)", value: "nay" }, { name: "Tháng trước", value: "truoc" })),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user");
    if (refusal) return respond(interaction, refusal);
    const settings = getSettings();
    const t = now();
    const last = interaction.options.getString("thang") === "truoc";
    const key = last ? previousMonthKey(t, settings.timezone) : monthKey(t, settings.timezone);
    if (last) {
      const w = recordMonthlyWinners(key, settings);
      return respond(interaction, { embeds: [leaderboardEmbed({ title: `Bảng xếp hạng tháng ${key}`, players: w.players, customers: w.customers })] });
    }
    const { from, to } = monthRange(key, settings.timezone);
    return respond(interaction, { embeds: [leaderboardEmbed({ title: `Bảng xếp hạng tháng ${key} (đến hiện tại)`, players: topPlayers({ from, to, limit: 5 }), customers: topCustomers({ from, to, limit: 5 }) })] });
  },
};
