import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { gate } from "../discord/access.js";
import { ensureLayout } from "../discord/layout.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

const list = (items) => (items.length ? items.map((i) => `- ${i}`).join("\n").slice(0, 1000) : "Không có.");

// Turns the layout report into one embed the owner can read at a glance
export function reportEmbed(report) {
  const embed = new EmbedBuilder()
    .setColor(report.problems.length ? COLORS.warn : COLORS.ok)
    .setTitle("Kết quả dựng server")
    .addFields({ name: `Đã tạo (${report.created.length})`, value: list(report.created) }, { name: `Đã có sẵn (${report.found.length})`, value: list(report.found) });
  if (report.fixed.length) embed.addFields({ name: "Đã cập nhật", value: list(report.fixed) });
  embed.addFields({ name: report.problems.length ? `Cần sửa (${report.problems.length})` : "Cần sửa", value: list(report.problems) });
  embed.setFooter({ text: "Chạy /setup lại bất cứ lúc nào, bot không tạo trùng và không xoá gì." });
  return embed;
}

export default {
  audited: true,
  data: new SlashCommandBuilder().setName("setup").setDescription("Dựng hoặc sửa các role, kênh và bảng hướng dẫn của server đặt lịch").setDefaultMemberPermissions(0).setDMPermission(false),

  async execute(interaction) {
    const refusal = gate(interaction, "owner");
    if (refusal) return respond(interaction, refusal);
    await defer(interaction);
    const report = await ensureLayout(interaction.guild, { botId: interaction.client.user?.id });
    return respond(interaction, { embeds: [reportEmbed(report)] });
  },
};
