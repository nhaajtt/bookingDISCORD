import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { actorFor, openDispute } from "../domain/bookings.js";
import { handleSafetyAlert, rateCustomer, recordSafetyAlert } from "../domain/trust.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { config } from "../config.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { channelOf, guildOf, mention, sendDm } from "../discord/guild.js";
import { limited } from "../discord/limits.js";
import { audit } from "../discord/moderation.js";
import { defer, respond, send } from "../discord/respond.js";
import { allowStaffInVoice } from "../discord/rooms.js";
import { COLORS, durationText } from "../discord/text.js";
import { disputeEmbed, disputeRows } from "./disputes.js";
import { stars } from "./booking.js";
import { log } from "../log.js";

// Trust and safety in Discord: the alert button in the room, and the player's stars for the customer.

// ---------------------------------------------------------------- the alert button

async function onAlert(interaction, [id]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "dispute");
  if (refusal) return respond(interaction, refusal);
  const t = now();
  const { alert, booking } = recordSafetyAlert(Number(id), interaction.user.id, t);
  const settings = getSettings();
  const guild = await guildOf(interaction);
  const rooms = [booking.text_channel_id && `<#${booking.text_channel_id}>`, booking.voice_channel_id && `<#${booking.voice_channel_id}>`].filter(Boolean).join(" ") || "Chưa có phòng";
  const channel = await channelOf(guild, "disputesChannelId");
  if (channel) {
    await send(channel, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.bad)
          .setTitle(`BÁO KHẨN cho lịch #${booking.id}`)
          .setDescription(`${mention(interaction.user.id)} vừa bấm nút báo khẩn trong phòng hẹn. Hãy vào xem ngay.`)
          .addFields(
            { name: "Khách", value: mention(booking.customer_id), inline: true },
            { name: "Player", value: mention(booking.player_id), inline: true },
            { name: "Giờ hẹn", value: `${formatLocal(booking.start_at, settings.timezone)}, ${durationText(booking.duration_min)}`, inline: true },
            { name: "Phòng", value: rooms },
          ),
      ],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`sf:done:${alert.id}`).setLabel("Đã xử lý").setStyle(ButtonStyle.Success))],
    }).catch((error) => log.error("safety.post_failed", { booking: booking.id, error }));
  }
  // The owners hear about it at once, in a private message, because the channel may not be watched at this hour
  for (const ownerId of config.ownerIds) await sendDm(interaction.client, ownerId, `Báo khẩn: ${mention(interaction.user.id)} cần hỗ trợ trong lịch #${booking.id}. Xem kênh khiếu nại hoặc vào phòng ngay.`);
  await allowStaffInVoice(guild, booking).catch((error) => log.error("safety.staff_voice_failed", { booking: booking.id, error }));
  // A session that is running or over is frozen like any other complaint, so no money moves while staff look into it
  try {
    const opened = openDispute(booking.id, actorFor(booking, interaction.user.id), "Báo khẩn về an toàn trong buổi hẹn", t);
    if (channel) await send(channel, { embeds: [disputeEmbed(opened.dispute, opened.booking)], components: disputeRows(opened.dispute.id) });
  } catch (error) {
    if (error.code !== "ILLEGAL_TRANSITION") throw error;
  }
  await audit(guild, `Báo khẩn #${alert.id} cho lịch #${booking.id} bởi ${mention(interaction.user.id)}; nhân viên được vào phòng voice.`);
  return respond(interaction, "Đã báo khẩn cho nhân viên và chủ server. Nếu bạn đang gặp nguy hiểm thật sự, hãy rời cuộc gọi và liên hệ cơ quan chức năng.");
}

async function onAlertDone(interaction, [alertId]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return respond(interaction, refusal);
  handleSafetyAlert(Number(alertId), interaction.user.id, now());
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, `Đã đánh dấu báo khẩn #${alertId} là đã xử lý.`);
}

// ---------------------------------------------------------------- the player rates the customer

async function onRateCustomer(interaction, [id, count]) {
  await defer(interaction);
  const refusal = gate(interaction, "player") ?? limited(interaction.user.id, "rate");
  if (refusal) return respond(interaction, refusal);
  const done = rateCustomer(Number(id), interaction.user.id, Number(count), "", now());
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, { content: `Cảm ơn bạn! Đã ghi nhận ${stars(done.stars)} cho khách. Chỉ nhân viên thấy đánh giá này.`, components: [] });
}

export default {
  auditedPrefixes: ["sf"],
  buttons: { "sf:alert": onAlert, "sf:done": onAlertDone, "cr:rate": onRateCustomer },
};
