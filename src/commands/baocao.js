import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { addReport, handleReport, reportsAbout } from "../domain/people.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { channelOf, guildOf, mention } from "../discord/guild.js";
import { limited } from "../discord/limits.js";
import { field, modal } from "../discord/modals.js";
import { defer, respond, send } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";

// An anonymous report to staff about a person or a problem. Staff see the text and who it is about, never who wrote it: the writer is
// stored only as a hash, which is enough to stop one person flooding the queue.

async function openForm(interaction) {
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const about = interaction.options.getUser("nguoi");
  if (about?.bot) return respond(interaction, "Không thể báo cáo một bot.");
  return interaction.showModal(modal(`rp:new:${about?.id ?? "0"}`, "Báo cáo ẩn danh", [{ id: "text", label: "Chuyện gì đã xảy ra?", max: 800, paragraph: true, placeholder: "Nhân viên không thấy tên bạn." }]));
}

async function submit(interaction, [aboutId]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "report");
  if (refusal) return respond(interaction, refusal);
  const about = aboutId && aboutId !== "0" ? aboutId : null;
  const report = addReport({ reporterId: interaction.user.id, aboutUserId: about, text: field(interaction, "text", 800) }, now());
  const guild = await guildOf(interaction);
  const channel = await channelOf(guild, "disputesChannelId");
  if (channel) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`Báo cáo ẩn danh #${report.id}`)
      .setDescription(report.text)
      .addFields(
        { name: "Về", value: about ? `${mention(about)} (đã bị báo cáo ${reportsAbout(about)} lần)` : "Không nêu tên ai", inline: true },
        { name: "Lúc", value: formatLocal(report.created_at, getSettings().timezone), inline: true },
      );
    await send(channel, { embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rp:done:${report.id}`).setLabel("Đã xử lý").setStyle(ButtonStyle.Success))] });
  }
  return respond(interaction, "Đã gửi báo cáo ẩn danh. Nhân viên sẽ xem xét, họ không biết bạn là ai.");
}

async function done(interaction, [id]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  handleReport(Number(id), now());
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, `Đã đánh dấu báo cáo #${id} là đã xử lý.`);
}

export default {
  auditedPrefixes: ["rp:done"],
  data: new SlashCommandBuilder()
    .setName("baocao")
    .setDescription("Gửi báo cáo ẩn danh cho nhân viên về một người hoặc một vấn đề")
    .setDMPermission(false)
    .addUserOption((o) => o.setName("nguoi").setDescription("Người bạn muốn báo cáo (không bắt buộc)")),
  execute: openForm,
  modals: { "rp:new": submit },
  buttons: { "rp:done": done },
};
