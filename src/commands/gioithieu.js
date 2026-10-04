import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { referralCodeFor, referralStats, useReferralCode } from "../domain/referrals.js";
import { formatVnd } from "../domain/pricing.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { mention } from "../discord/guild.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

// Referral: share your code, a friend enters it before their first booking, and when their first session is done both get wallet credit.

async function myCode(interaction, settings) {
  const userId = interaction.user.id;
  if (!settings.referral.rewardVnd) return respond(interaction, "Chương trình giới thiệu đang tắt.");
  const stats = referralStats(userId);
  const embed = new EmbedBuilder()
    .setColor(COLORS.ok)
    .setTitle("Giới thiệu bạn bè")
    .setDescription(`Mã của bạn: **${referralCodeFor(userId, now())}**\nBạn bè nhập mã bằng \`/gioithieu nhap\` trước khi đặt lịch đầu tiên. Khi họ hoàn thành buổi chơi đầu tiên (từ ${formatVnd(settings.referral.minPriceVnd)}), mỗi người nhận ${formatVnd(settings.referral.rewardVnd)} vào ví.`)
    .addFields({ name: "Đã mời", value: String(stats.invited), inline: true }, { name: "Đã nhận thưởng", value: `${stats.rewarded} (${formatVnd(stats.earnedVnd)})`, inline: true });
  if (stats.referredBy) embed.addFields({ name: "Bạn được mời bởi", value: mention(stats.referredBy), inline: true });
  return respond(interaction, { embeds: [embed] });
}

export default {
  data: new SlashCommandBuilder()
    .setName("gioithieu")
    .setDescription("Mời bạn bè dùng dịch vụ, cả hai cùng nhận thưởng vào ví")
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("ma").setDescription("Xem mã giới thiệu của bạn và số người đã mời"))
    .addSubcommand((s) => s.setName("nhap").setDescription("Nhập mã của người đã mời bạn").addStringOption((o) => o.setName("ma").setDescription("Mã giới thiệu").setRequired(true).setMaxLength(12))),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user");
    if (refusal) return respond(interaction, refusal);
    const settings = getSettings();
    if (interaction.options.getSubcommand() === "nhap") {
      const limit = limited(interaction.user.id, "wallet");
      if (limit) return respond(interaction, limit);
      const done = useReferralCode(interaction.user.id, interaction.options.getString("ma"), now(), settings);
      return respond(interaction, `Đã ghi nhận bạn được ${mention(done.referrerId)} mời. Khi buổi chơi đầu tiên của bạn hoàn thành, hai bạn cùng nhận ${formatVnd(settings.referral.rewardVnd)} vào ví.`);
    }
    return myCode(interaction, settings);
  },
};
