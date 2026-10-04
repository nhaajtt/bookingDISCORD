import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { recommendFor } from "../domain/recommend.js";
import { formatVnd } from "../domain/pricing.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

// Suggestions made from what the customer already booked and liked, every one with the reason it was picked.

export default {
  data: new SlashCommandBuilder().setName("goiy").setDescription("Gợi ý player hợp với bạn dựa trên những lần đặt trước").setDMPermission(false),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "search");
    if (refusal) return respond(interaction, refusal);
    const picks = recommendFor(interaction.user.id, now(), { limit: 5 }, getSettings());
    if (!picks.length) return respond(interaction, "Hiện chưa có player nào để gợi ý. Bạn thử lại sau nhé.");
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle("Gợi ý cho bạn")
      .setDescription(picks.map((p, i) => `${i + 1}. **${p.displayName}** | ${formatVnd(p.rateVnd)}/giờ | ${p.reasons.join(", ") || "player mới"}`).join("\n"))
      .setFooter({ text: "Chọn dựa trên game bạn từng đặt, đánh giá và ai đang rảnh. Bấm số để đặt lịch." });
    const buttons = picks.map((p, i) => new ButtonBuilder().setCustomId(`pl:book:${p.userId}`).setLabel(`${i + 1}. ${p.displayName}`.slice(0, 80)).setStyle(ButtonStyle.Primary));
    return respond(interaction, { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] });
  },
};
