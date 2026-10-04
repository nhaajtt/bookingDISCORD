import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { getDb } from "../db.js";
import { confirmManualOrder } from "../jobs/payments.js";
import { getOrder } from "../pay/orders.js";
import { ORDER_TTL_MS } from "../pay/orders.js";
import { receivingAccount, transferInstructions } from "../pay/manual.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { guildOf, mention } from "../discord/guild.js";
import { limited } from "../discord/limits.js";
import { audit, moneyLog } from "../discord/moderation.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";
import { describeOrder } from "../pay/orders.js";

// Bank transfers to the owner's own account. A customer pays, the owner sees the money in their banking app and presses "Đã nhận tiền";
// only then does the booking, the wallet or the session move. Nothing is confirmed on the customer's word alone.

const KIND = { BOOKING: "đặt lịch", EXTEND: "gia hạn", TOPUP: "nạp ví" };

export const noteOf = (order) => describeOrder(order.order_code, order.kind);

export function pendingTransfers(t = now()) {
  return getDb().prepare("SELECT * FROM orders WHERE provider = 'manual' AND status = 'PENDING' AND created_at > ? ORDER BY created_at").all(t - ORDER_TTL_MS);
}

export const confirmRow = (order) =>
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mp:ok:${order.order_code}`).setLabel(`Đã nhận ${formatVnd(order.amount)}`.slice(0, 80)).setStyle(ButtonStyle.Success));

export function transferEmbed(order, settings = getSettings(), told = false) {
  const bank = receivingAccount();
  return new EmbedBuilder()
    .setColor(told ? COLORS.warn : COLORS.money)
    .setTitle(`${told ? "Khách báo đã chuyển: " : "Chờ chuyển khoản: "}${KIND[order.kind] ?? "đơn"} ${order.booking_id ? `#${order.booking_id}` : ""}`.trim())
    .addFields(
      { name: "Khách", value: mention(order.user_id), inline: true },
      { name: "Số tiền", value: formatVnd(order.amount), inline: true },
      { name: "Nội dung chuyển", value: `\`${noteOf(order)}\``, inline: true },
      { name: "Tạo lúc", value: formatLocal(order.created_at, settings.timezone), inline: true },
      ...(bank ? [{ name: "Tài khoản nhận", value: `${bank.bank_name} ${bank.account_no}`, inline: true }] : []),
    )
    .setFooter({ text: "Mở app ngân hàng, thấy đúng số tiền và nội dung thì bấm Đã nhận. Chưa thấy tiền thì cứ để đó." });
}

// ---------------------------------------------------------------- the owner confirms

async function onConfirm(interaction, [code]) {
  await defer(interaction);
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  const order = getOrder(Number(code));
  const result = await confirmManualOrder(interaction.client, Number(code), now());
  if (!result.ok) return respond(interaction, result.reason);
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  const guild = await guildOf(interaction);
  await audit(guild, `${mention(interaction.user.id)} xác nhận đã nhận ${formatVnd(order.amount)} (đơn #${order.order_code}, ${KIND[order.kind] ?? "đơn"}).`);
  return respond(interaction, result.late ? "Đã xác nhận, nhưng lịch đã hết hạn nên khoản này được ghi nợ hoàn lại cho khách." : "Đã xác nhận. Khách được báo ngay.");
}

// ---------------------------------------------------------------- the customer says it is done

async function onTold(interaction, [code]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "dispute");
  if (refusal) return respond(interaction, refusal);
  const order = getOrder(Number(code));
  if (!order || order.provider !== "manual" || order.user_id !== interaction.user.id) return respond(interaction, "Không tìm thấy đơn của bạn.");
  if (order.status === "PAID") return respond(interaction, "Đơn này đã được xác nhận rồi, bạn không cần làm gì thêm.");
  const guild = await guildOf(interaction);
  await moneyLog(guild, { embeds: [transferEmbed(order, getSettings(), true)], components: [confirmRow(order)] });
  return respond(interaction, "Đã báo cho chủ server. Khi tiền về tài khoản, bạn sẽ nhận được tin xác nhận.");
}

export const toldButton = (order) => new ButtonBuilder().setCustomId(`mp:told:${order.order_code}`).setLabel("Tôi đã chuyển khoản").setStyle(ButtonStyle.Primary);

// For the messages that carry a payment link: when the order is a bank transfer, the words to show and the extra button
export function manualExtras(orderCode) {
  if (!orderCode) return null;
  const order = getOrder(orderCode);
  if (!order || order.provider !== "manual") return null;
  return { text: transferInstructions(order.amount, noteOf(order)), button: toldButton(order), linkLabel: "Xem mã QR" };
}

export default {
  auditedPrefixes: ["mp"],
  buttons: { "mp:ok": onConfirm, "mp:told": onTold },
};
