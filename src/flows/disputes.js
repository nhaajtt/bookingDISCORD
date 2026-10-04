import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { getSettings } from "../settings.js";
import { actorFor, getBooking, getDispute, listBookings, openDispute, resolveDispute, staffActor } from "../domain/bookings.js";
import { markActionDone } from "../domain/schedule.js";
import { activeStrikeCount } from "../domain/strikes.js";
import { disputeFlag } from "../domain/people.js";
import { getPlayer } from "../domain/players.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { DomainError } from "../domain/errors.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { channelOf, guildOf, mention, nameOf, sendDm } from "../discord/guild.js";
import { limited } from "../discord/limits.js";
import { field, modal, rawField } from "../discord/modals.js";
import { afterStrike, audit, moneyLog } from "../discord/moderation.js";
import { isStaff } from "../discord/permissions.js";
import { defer, respond, send } from "../discord/respond.js";
import { allowStaffInVoice, closeRooms } from "../discord/rooms.js";
import { COLORS, STATUS_VI, durationText } from "../discord/text.js";
import { cancelAndNotify } from "./booking.js";
import { log } from "../log.js";

// Disputes: a customer, player or staff member reports a problem, staff decide with buttons. The money stays frozen until then.

export const OUTCOME_LABEL = { pay_player: "Trả đủ cho player", refund_customer: "Hoàn 100% cho khách", split: "Chia theo phần trăm" };

export function disputeEmbed(dispute, booking, settings = getSettings()) {
  const rooms = [booking.text_channel_id && `<#${booking.text_channel_id}>`, booking.voice_channel_id && `<#${booking.voice_channel_id}>`].filter(Boolean).join(" ") || "Chưa có phòng";
  return new EmbedBuilder()
    .setColor(COLORS.bad)
    .setTitle(`Khiếu nại #${dispute.id} cho lịch #${booking.id}`)
    .addFields(
      { name: "Khách", value: mention(booking.customer_id), inline: true },
      { name: "Player", value: mention(booking.player_id), inline: true },
      { name: "Người báo", value: mention(dispute.opener_id), inline: true },
      { name: "Game", value: booking.game, inline: true },
      { name: "Giờ hẹn", value: `${formatLocal(booking.start_at, settings.timezone)}, ${durationText(booking.duration_min)}`, inline: true },
      { name: "Giá", value: formatVnd(booking.price_vnd), inline: true },
      { name: "Lý do", value: dispute.reason || "Không ghi" },
      { name: "Phòng", value: rooms },
    );
}

export const disputeRows = (disputeId) => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dp:resolve:${disputeId}:pay_player`).setLabel("Trả cho player").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dp:resolve:${disputeId}:refund_customer`).setLabel("Hoàn cho khách").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`dp:resolve:${disputeId}:split`).setLabel("Chia").setStyle(ButtonStyle.Secondary),
  ),
];

function actorOf(interaction, booking) {
  return actorFor(booking, interaction.user.id, { isStaff: isStaff(interaction.member, interaction.user.id) });
}

// ---------------------------------------------------------------- opening

async function askProblem(interaction, [id]) {
  const staff = isStaff(interaction.member, interaction.user.id);
  const refusal = staff ? null : gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const booking = getBooking(Number(id));
  if (!booking) throw new DomainError("NOT_FOUND", { what: "lịch" });
  actorOf(interaction, booking);
  return interaction.showModal(modal(`bk:problem:submit:${booking.id}`, "Báo cáo sự cố", [{ id: "reason", label: "Mô tả sự cố", max: 500, paragraph: true }]));
}

async function submitProblem(interaction, [id]) {
  await defer(interaction);
  const staff = isStaff(interaction.member, interaction.user.id);
  const refusal = (staff ? null : gate(interaction, "user")) ?? limited(interaction.user.id, "dispute");
  if (refusal) return respond(interaction, refusal);
  const booking = getBooking(Number(id));
  if (!booking) throw new DomainError("NOT_FOUND", { what: "lịch" });
  const actor = actorOf(interaction, booking);
  let opened;
  try {
    opened = openDispute(booking.id, actor, field(interaction, "reason", 500), now());
  } catch (error) {
    if (error.code === "ILLEGAL_TRANSITION") return respond(interaction, `Chưa thể báo cáo sự cố cho lịch đang ở trạng thái "${STATUS_VI[booking.status] ?? booking.status}". Báo cáo được sau khi buổi hẹn bắt đầu.`);
    throw error;
  }
  const { dispute } = opened;
  const guild = await guildOf(interaction);
  const channel = await channelOf(guild, "disputesChannelId");
  if (channel) await send(channel, { embeds: [disputeEmbed(dispute, opened.booking)], components: disputeRows(dispute.id) });
  if (channel && actor.role === "customer") {
    const flag = disputeFlag(booking.customer_id, now());
    if (flag.flagged) {
      await send(channel, `Cần xem xét: ${mention(booking.customer_id)} đã mở ${flag.opened} khiếu nại trong ${flag.days} ngày qua (${flag.rejected} cái đã bị bác). Dùng /staff xem-khach để xem chi tiết.`, [booking.customer_id]);
    }
  }
  await allowStaffInVoice(guild, opened.booking).catch((error) => log.error("dispute.staff_voice_failed", { booking: booking.id, error }));
  await audit(guild, `Khiếu nại #${dispute.id} mở cho lịch #${booking.id} bởi ${mention(interaction.user.id)}; nhân viên được vào phòng voice.`);
  const other = actor.role === "customer" ? booking.player_id : actor.role === "player" ? booking.customer_id : null;
  const note = `Lịch #${booking.id} có báo cáo sự cố. Nhân viên sẽ xem xét, khoản tiền của buổi này được giữ lại cho đến khi có kết quả.`;
  if (other) await sendDm(interaction.client, other, note);
  return respond(interaction, "Đã gửi báo cáo, nhân viên sẽ xem xét. Khoản tiền của buổi này được giữ lại cho đến khi có kết quả.");
}

// ---------------------------------------------------------------- resolving

const EXTRAS = { n: "Xác nhận", p: "Xác nhận và phạt player", c: "Xác nhận và phạt khách", x: "Xác nhận và xoá cảnh cáo của lịch" };

async function askResolve(interaction, [disputeId, outcome]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return respond(interaction, refusal);
  const dispute = getDispute(Number(disputeId));
  if (!dispute) throw new DomainError("NOT_FOUND", { what: "khiếu nại" });
  if (dispute.status !== "OPEN") return respond(interaction, "Khiếu nại này đã được xử lý rồi.");
  const messageId = interaction.message?.id ?? "0";
  if (outcome === "split") {
    return interaction.showModal(
      modal(`dp:split:submit:${dispute.id}:${messageId}`, "Chia tiền khiếu nại", [
        { id: "percent", label: "Phần trăm hoàn cho khách (1 đến 99)", max: 2, value: "50" },
        { id: "note", label: "Ghi chú", max: 300, paragraph: true, required: false },
      ]),
    );
  }
  const row = new ActionRowBuilder().addComponents(
    Object.entries(EXTRAS).map(([extra, label]) =>
      new ButtonBuilder().setCustomId(`dp:do:${dispute.id}:${outcome}:${extra}:${messageId}`).setLabel(label).setStyle(extra === "n" ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
  return respond(interaction, { content: `Khiếu nại #${dispute.id}: ${OUTCOME_LABEL[outcome] ?? outcome}. Xác nhận quyết định này? Không hoàn tác được.`, components: [row] });
}

export const outcomeText = (outcome, percent, refundVnd) =>
  outcome === "pay_player" ? "Khiếu nại đã xử lý: player được thanh toán đủ." : outcome === "refund_customer" ? "Khiếu nại đã xử lý: bạn được hoàn 100%." : `Khiếu nại đã xử lý: hoàn ${percent}% (${formatVnd(refundVnd)}), phần còn lại trả cho player.`;

async function finish(interaction, disputeId, outcome, options, note, messageId) {
  const guild = interaction.guild;
  const dispute = getDispute(Number(disputeId));
  if (!dispute) throw new DomainError("NOT_FOUND", { what: "khiếu nại" });
  const booking = getBooking(dispute.booking_id);
  const t = now();
  const before = getPlayer(booking.player_id)?.status;
  let result;
  try {
    result = resolveDispute(dispute.id, outcome, interaction.user.id, note, t, options);
  } catch (error) {
    if (error.code === "ILLEGAL_TRANSITION") return respond(interaction, "Khiếu nại này đã được xử lý rồi.");
    throw error; // SETTLED_ALREADY: the staff settle by hand, the dispute stays open
  }
  const percent = options.percent ?? null;
  const text = outcomeText(outcome, percent, result.refundVnd);

  const after = getPlayer(booking.player_id)?.status;
  if (after === "SUSPENDED" && before !== "SUSPENDED") await afterStrike(guild, booking.player_id, { suspended: true }, activeStrikeCount(booking.player_id, t));

  // Close the rooms: they were kept open for the dispute
  try {
    await closeRooms(guild, booking);
    markActionDone(booking.id, "closeRooms", t);
  } catch (error) {
    log.error("dispute.close_rooms_failed", { booking: booking.id, error });
  }
  await sendDm(interaction.client, booking.customer_id, text);
  await sendDm(interaction.client, booking.player_id, `Lịch #${booking.id}: ${outcome === "pay_player" ? "khiếu nại đã xử lý, bạn được thanh toán đủ." : outcome === "refund_customer" ? "khiếu nại đã xử lý, khách được hoàn 100%." : `khiếu nại đã xử lý, hoàn ${percent}% cho khách, phần còn lại trả cho bạn.`}`);

  const who = nameOf(interaction.member ?? interaction.user);
  if (messageId && messageId !== "0") {
    const channel = await channelOf(guild, "disputesChannelId");
    const message = await channel?.messages?.fetch(messageId).catch(() => null);
    if (message) {
      const source = message.embeds?.[0];
      const embed = source ? EmbedBuilder.from(source) : new EmbedBuilder();
      embed.setFooter({ text: `${OUTCOME_LABEL[outcome]}${percent ? ` (${percent}%)` : ""} bởi ${who} lúc ${formatLocal(t, getSettings().timezone)}` });
      await message.edit({ embeds: [embed], components: [] }).catch(() => {});
    }
  }
  await audit(guild, `Khiếu nại #${dispute.id} (lịch #${booking.id}) xử lý bởi ${who}: ${OUTCOME_LABEL[outcome]}${options.strike ? `, phạt ${options.strike === "player" ? "player" : "khách"}` : ""}${options.clearStrikes ? ", xoá cảnh cáo" : ""}.`);
  await moneyLog(guild, `Khiếu nại #${dispute.id} (lịch #${booking.id}): ${OUTCOME_LABEL[outcome]}, hoàn ${formatVnd(result.refundVnd)} cho khách.`);
  return respond(interaction, { content: `Đã xử lý khiếu nại #${dispute.id}: ${OUTCOME_LABEL[outcome]}.`, components: [] });
}

async function doResolve(interaction, [disputeId, outcome, extra, messageId]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const options = {};
  if (extra === "p") options.strike = "player";
  if (extra === "c") options.strike = "customer";
  if (extra === "x") options.clearStrikes = true;
  return finish(interaction, disputeId, outcome, options, "", messageId);
}

async function submitSplit(interaction, [disputeId, messageId]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const percent = Number(rawField(interaction, "percent"));
  if (!Number.isInteger(percent) || percent < 1 || percent > 99) return respond(interaction, "Phần trăm hoàn phải là số nguyên từ 1 đến 99.");
  return finish(interaction, disputeId, "split", { percent }, field(interaction, "note", 300), messageId);
}

// ---------------------------------------------------------------- a suspended player's upcoming bookings

async function cancelUpcoming(interaction, [playerId]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const t = now();
  const upcoming = listBookings({ playerId, statuses: ["AWAITING_PAYMENT", "CONFIRMED"], from: t });
  let cancelled = 0;
  let refunded = 0;
  for (const booking of upcoming) {
    try {
      const result = await cancelAndNotify(interaction.guild, interaction.client, booking.id, staffActor(interaction.user.id), "player không còn nhận lịch");
      cancelled += 1;
      refunded += result.refundVnd;
    } catch (error) {
      log.error("dispute.cancel_failed", { booking: booking.id, error });
    }
  }
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, cancelled ? `Đã huỷ ${cancelled} lịch sắp tới, ghi nợ hoàn ${formatVnd(refunded)} cho khách.` : "Không có lịch sắp tới nào cần huỷ.");
}

export default {
  auditedPrefixes: ["dp"],
  buttons: {
    "bk:problem": askProblem,
    "dp:resolve": askResolve,
    "dp:do": doResolve,
    "dp:cancelupcoming": cancelUpcoming,
  },
  modals: {
    "bk:problem:submit": submitProblem,
    "dp:split:submit": submitSplit,
  },
};
