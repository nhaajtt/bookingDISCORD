import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { activeMembership, buyMembership, planFor } from "../domain/memberships.js";
import { walletBalance } from "../domain/wallet.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

// Paid membership: buy a plan from the wallet, get a percent off every booking while it runs.

function overview(userId, settings) {
  const mine = activeMembership(userId, now());
  const embed = new EmbedBuilder().setColor(COLORS.money).setTitle("Gói thành viên");
  if (!settings.memberships.length) return embed.setDescription("Hiện chưa có gói thành viên nào.");
  embed.setDescription(settings.memberships.map((p) => `**${p.name}**: ${formatVnd(p.priceVnd)} cho ${p.days} ngày, giảm ${p.discountPercent}% mỗi lịch`).join("\n"));
  embed.addFields({ name: "Của bạn", value: mine ? `${mine.planName}, giảm ${mine.discountPercent}% đến ${formatLocal(mine.expiresAt, settings.timezone)}` : "Chưa có gói nào đang chạy.", inline: true }, { name: "Số dư ví", value: formatVnd(walletBalance(userId)), inline: true });
  embed.setFooter({ text: "Mua bằng tiền trong ví (dùng /vi nap để nạp). Mua lại khi gói còn hạn sẽ cộng thêm ngày." });
  return embed;
}

async function show(interaction) {
  const settings = getSettings();
  const buttons = settings.memberships.map((p) => new ButtonBuilder().setCustomId(`mb:buy:${p.id}`).setLabel(`Mua ${p.name} ${formatVnd(p.priceVnd)}`.slice(0, 80)).setStyle(ButtonStyle.Success));
  return respond(interaction, { embeds: [overview(interaction.user.id, settings)], components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [] });
}

async function buy(interaction, [planId]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "wallet");
  if (refusal) return respond(interaction, refusal);
  const settings = getSettings();
  const plan = planFor(planId, settings);
  const done = buyMembership(interaction.user.id, plan.id, now(), settings);
  return respond(interaction, `Đã mua gói ${plan.name}: giảm ${plan.discountPercent}% mỗi lịch đến ${formatLocal(done.membership.expiresAt, settings.timezone)}. Ví còn ${formatVnd(done.balance)}.`);
}

export default {
  data: new SlashCommandBuilder().setName("thanhvien").setDescription("Gói thành viên: mua gói để được giảm giá mỗi lần đặt lịch").setDMPermission(false),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user");
    if (refusal) return respond(interaction, refusal);
    return show(interaction);
  },

  buttons: { "mb:buy": buy },
};
