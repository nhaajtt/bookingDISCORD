import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { bonusFor, loyaltyPoints, packageFor, redeemPoints, walletBalance, walletHistory } from "../domain/wallet.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { checkoutTopup } from "../pay/checkout.js";
import { manualExtras } from "../flows/manualpay.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";
import { alert } from "../alerts.js";
import { log } from "../log.js";

// A prepaid wallet: top up with a package (and get a bonus), pay bookings from it, turn loyalty points into credit. The credit is
// service the owner owes, not money the bot holds; it can only be spent on bookings.

const KIND = { TOPUP: "Nạp ví", BONUS: "Tặng thêm", SPEND: "Thanh toán", REFUND: "Hoàn về ví", POINTS: "Đổi điểm", ADJUST: "Điều chỉnh" };

function overview(userId, settings) {
  const balance = walletBalance(userId);
  const points = loyaltyPoints(userId, settings);
  const history = walletHistory(userId, 8);
  const embed = new EmbedBuilder()
    .setColor(COLORS.money)
    .setTitle("Ví của bạn")
    .addFields(
      { name: "Số dư", value: formatVnd(balance), inline: true },
      { name: "Điểm thưởng", value: points.enabled ? `${points.available} điểm (đổi tối thiểu ${points.minRedeem}, mỗi điểm ${formatVnd(points.pointValueVnd)})` : "Đang tắt", inline: true },
    );
  if (history.length) embed.addFields({ name: "Gần đây", value: history.map((h) => `${formatLocal(h.created_at, settings.timezone)} | ${KIND[h.kind]} | ${h.amount_vnd > 0 ? "+" : ""}${formatVnd(h.amount_vnd)}${h.note ? ` | ${h.note}` : ""}`).join("\n").slice(0, 1000) });
  embed.setFooter({ text: "Tiền trong ví chỉ dùng để thanh toán lịch. Dùng /vi nap để nạp thêm." });
  return embed;
}

function packageRows(settings) {
  const buttons = settings.packages.map((p) =>
    new ButtonBuilder()
      .setCustomId(`wl:topup:${p.amountVnd}`)
      .setLabel(`${formatVnd(p.amountVnd)}${p.bonusPercent ? ` +${p.bonusPercent}%` : ""}`.slice(0, 80))
      .setStyle(ButtonStyle.Primary),
  );
  return [new ActionRowBuilder().addComponents(buttons.slice(0, 5)), ...(buttons.length > 5 ? [new ActionRowBuilder().addComponents(buttons.slice(5))] : [])];
}

async function nap(interaction, settings) {
  if (!settings.packages.length) return respond(interaction, "Hiện chưa có gói nạp nào. Bạn vẫn thanh toán trực tiếp khi đặt lịch được nhé.");
  const lines = settings.packages.map((p) => `Nạp ${formatVnd(p.amountVnd)}: nhận ${formatVnd(p.amountVnd + bonusFor(p.amountVnd, p.bonusPercent))}${p.bonusPercent ? ` (tặng thêm ${p.bonusPercent}%)` : ""}`);
  return respond(interaction, { content: `Chọn gói nạp:\n${lines.join("\n")}`, components: packageRows(settings) });
}

async function topup(interaction, [amount]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "wallet");
  if (refusal) return respond(interaction, refusal);
  const pack = packageFor(Number(amount), getSettings());
  try {
    const link = await checkoutTopup(interaction.user.id, pack.amountVnd, bonusFor(pack.amountVnd, pack.bonusPercent), now());
    const manual = manualExtras(link.orderCode);
    return respond(interaction, {
      content: `Nạp ${formatVnd(pack.amountVnd)}, nhận ${formatVnd(pack.amountVnd + bonusFor(pack.amountVnd, pack.bonusPercent))} vào ví. ${manual ? manual.text : "Thanh toán xong ví được cộng trong ít phút."}`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link.checkoutUrl).setLabel(manual ? manual.linkLabel : "Thanh toán"), ...(manual ? [manual.button] : []))],
    });
  } catch (error) {
    log.error("payment.topup_link_failed", { user: interaction.user.id, error });
    alert(`Không tạo được link nạp ví: ${error.message}`);
    return respond(interaction, "Hệ thống thanh toán đang bận, bạn thử lại sau ít phút nhé.");
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("vi")
    .setDescription("Ví của bạn: số dư, nạp tiền có thưởng, đổi điểm thành tiền")
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("xem").setDescription("Xem số dư, điểm thưởng và lịch sử ví"))
    .addSubcommand((s) => s.setName("nap").setDescription("Nạp tiền vào ví theo gói (có tặng thêm)"))
    .addSubcommand((s) =>
      s.setName("doi-diem").setDescription("Đổi điểm thưởng thành tiền trong ví").addIntegerOption((o) => o.setName("so-diem").setDescription("Số điểm muốn đổi").setRequired(true).setMinValue(1)),
    ),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user");
    if (refusal) return respond(interaction, refusal);
    const settings = getSettings();
    const sub = interaction.options.getSubcommand();
    if (sub === "nap") return nap(interaction, settings);
    if (sub === "doi-diem") {
      const limit = limited(interaction.user.id, "wallet");
      if (limit) return respond(interaction, limit);
      const done = redeemPoints(interaction.user.id, interaction.options.getInteger("so-diem"), now(), settings);
      return respond(interaction, `Đã đổi ${done.points} điểm thành ${formatVnd(done.creditVnd)}. Ví còn ${formatVnd(done.balance)}.`);
    }
    return respond(interaction, { embeds: [overview(interaction.user.id, settings)] });
  },

  buttons: { "wl:topup": topup },
};
