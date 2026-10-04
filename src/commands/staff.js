import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { addNote, customerProfile, deleteNote, reportsAbout } from "../domain/people.js";
import { formatLocal } from "../domain/time.js";
import { getBooking, listBookings, listOpenDisputes, staffActor } from "../domain/bookings.js";
import { getPlayer, listPlayers, suspendPlayer } from "../domain/players.js";
import { addStrike, addToBlacklist, liftSuspension, removeFromBlacklist } from "../domain/strikes.js";
import { ownerSummary } from "../domain/summary.js";
import { sanitizeText } from "../domain/ratings.js";
import { RISK_LEVEL, customerRating, customerRisk, unverifyPlayer, verifyPlayer } from "../domain/trust.js";
import { formatVnd } from "../domain/pricing.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { refreshCard } from "../discord/cards.js";
import { now } from "../discord/clock.js";
import { fetchMember, mention, nameOf } from "../discord/guild.js";
import { afterStrike, audit } from "../discord/moderation.js";
import { isStaff } from "../discord/permissions.js";
import { defer, respond } from "../discord/respond.js";
import { grantRole, revokeRole } from "../discord/roles.js";
import { COLORS, STATUS_VI, summaryEmbed } from "../discord/text.js";
import { cancelAndNotify } from "../flows/booking.js";
import { disputeEmbed, disputeRows } from "../flows/disputes.js";
import { decisionRow, queueEmbed } from "../flows/players.js";

const user = (o, description = "Người dùng") => o.setName("user").setDescription(description).setRequired(true);
const reason = (o) => o.setName("ly-do").setDescription("Lý do").setRequired(true).setMaxLength(300);

async function duyet(interaction) {
  const pending = listPlayers({ status: "PENDING" }).slice(0, 5);
  if (!pending.length) return respond(interaction, "Không có hồ sơ nào đang chờ duyệt.");
  return respond(interaction, { embeds: pending.map((p) => queueEmbed(p, p.userId)), components: pending.map((p) => decisionRow(p.userId)) });
}

async function khieuNai(interaction) {
  const open = listOpenDisputes().slice(0, 5);
  if (!open.length) return respond(interaction, "Không có khiếu nại nào đang mở.");
  return respond(interaction, { embeds: open.map((d) => disputeEmbed(d, getBooking(d.booking_id))), components: open.flatMap((d) => disputeRows(d.id)) });
}

async function huyLich(interaction) {
  const id = interaction.options.getInteger("id");
  const why = sanitizeText(interaction.options.getString("ly-do") ?? "", 200) || "nhân viên huỷ";
  const result = await cancelAndNotify(interaction.guild, interaction.client, id, staffActor(interaction.user.id), why);
  return respond(interaction, `Đã huỷ lịch #${id}, hoàn ${formatVnd(result.refundVnd)} cho khách.`);
}

async function phat(interaction) {
  const target = interaction.options.getUser("user");
  const why = sanitizeText(interaction.options.getString("ly-do"), 200);
  if (!why) return respond(interaction, "Cần ghi lý do.");
  const t = now();
  const strike = addStrike(target.id, null, why, t);
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} phạt ${mention(target.id)}: ${why} (${strike.count} cảnh cáo).`);
  if (strike.suspended) await afterStrike(interaction.guild, target.id, strike);
  return respond(interaction, `Đã ghi cảnh cáo cho ${mention(target.id)}: hiện có ${strike.count} cảnh cáo.${strike.suspended ? " Player đã bị tạm khoá." : ""}`);
}

async function moKhoa(interaction) {
  const target = interaction.options.getUser("user");
  liftSuspension(target.id, interaction.user.id, now());
  await grantRole(interaction.guild, target.id, "player");
  await refreshCard(interaction.guild, target.id).catch(() => {});
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} mở khoá player ${mention(target.id)}.`);
  return respond(interaction, `Đã mở khoá ${getPlayer(target.id)?.displayName ?? mention(target.id)}.`);
}

async function cam(interaction) {
  const target = interaction.options.getUser("user");
  const why = sanitizeText(interaction.options.getString("ly-do"), 300);
  if (target.bot || target.id === interaction.user.id) return respond(interaction, "Không thể cấm người này.");
  const member = await fetchMember(interaction.guild, target.id);
  if (member && isStaff(member, target.id)) return respond(interaction, "Không thể cấm nhân viên hoặc chủ server.");
  addToBlacklist(target.id, why, interaction.user.id, now());
  const player = getPlayer(target.id);
  let upcoming = [];
  if (player) {
    try {
      suspendPlayer(target.id);
    } catch {
      // Already rejected or suspended: nothing to change
    }
    await revokeRole(interaction.guild, target.id, "player");
    await refreshCard(interaction.guild, target.id).catch(() => {});
    upcoming = listBookings({ playerId: target.id, statuses: ["AWAITING_PAYMENT", "CONFIRMED"], from: now() });
  }
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} cấm ${mention(target.id)}: ${why}.`);
  const payload = { content: `Đã cấm ${mention(target.id)}.${upcoming.length ? ` Người này còn ${upcoming.length} lịch sắp tới, bấm nút nếu muốn huỷ và hoàn tiền cho khách.` : ""}` };
  if (upcoming.length) {
    payload.components = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dp:cancelupcoming:${target.id}`).setLabel("Huỷ các lịch sắp tới và hoàn tiền").setStyle(ButtonStyle.Danger))];
  }
  return respond(interaction, payload);
}

async function boCam(interaction) {
  const target = interaction.options.getUser("user");
  if (!removeFromBlacklist(target.id)) return respond(interaction, "Người này không nằm trong danh sách cấm.");
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} bỏ cấm ${mention(target.id)}.`);
  return respond(interaction, "Đã bỏ cấm.");
}

async function tongKet(interaction) {
  const settings = getSettings();
  return respond(interaction, { embeds: [summaryEmbed(ownerSummary(now(), { settings }), settings, "Tổng kết")] });
}

async function ghiChu(interaction) {
  const target = interaction.options.getUser("user");
  const id = addNote(target.id, interaction.options.getString("noi-dung"), interaction.user.id, now());
  return respond(interaction, `Đã ghi chú #${id} về ${mention(target.id)}. Chỉ nhân viên xem được.`);
}

async function xoaGhiChu(interaction) {
  const id = interaction.options.getInteger("id");
  return respond(interaction, deleteNote(id) ? `Đã xoá ghi chú #${id}.` : "Không tìm thấy ghi chú này.");
}

// Everything staff need to judge a person at a glance
export function customerEmbed(userId, t = now(), settings = getSettings()) {
  const p = customerProfile(userId, t, settings);
  const risk = customerRisk(userId, t, settings);
  const rating = customerRating(userId);
  const statuses = Object.entries(p.byStatus).map(([s, n]) => `${STATUS_VI[s] ?? s}: ${n}`).join(", ") || "Chưa có lịch";
  const embed = new EmbedBuilder()
    .setColor(p.blacklisted || p.disputes.flagged || risk.level === "HIGH" ? COLORS.bad : risk.level === "MEDIUM" ? COLORS.warn : COLORS.info)
    .setTitle("Thông tin khách")
    .setDescription(mention(userId))
    .addFields(
      { name: "Lịch", value: `${p.bookings} lịch (${statuses})`, inline: false },
      { name: "Đã chi", value: formatVnd(p.spentVnd), inline: true },
      { name: "Lịch gần nhất", value: p.lastBookingAt ? formatLocal(p.lastBookingAt, settings.timezone) : "Chưa có", inline: true },
      { name: "Cảnh cáo còn hiệu lực", value: String(p.strikes), inline: true },
      { name: `Khiếu nại trong ${p.disputes.days} ngày`, value: `Đã mở ${p.disputes.opened}, bị bác ${p.disputes.rejected}${p.disputes.flagged ? " (cần xem xét)" : ""}`, inline: true },
      { name: "Bị người khác báo cáo", value: String(reportsAbout(userId)), inline: true },
      { name: "Danh sách cấm", value: p.blacklisted ? `Có: ${p.blacklisted.reason}` : "Không", inline: true },
      { name: "Player chấm khách", value: rating.count ? `${rating.average} sao (${rating.count} lượt)` : "Chưa có", inline: true },
      { name: `Mức rủi ro: ${RISK_LEVEL[risk.level]} (${risk.points} điểm)`, value: risk.reasons.length ? risk.reasons.join("\n").slice(0, 1000) : "Không có dấu hiệu đáng lo." },
    );
  if (p.notes.length) embed.addFields({ name: "Ghi chú nội bộ", value: p.notes.map((n) => `#${n.id} ${n.note}`).join("\n").slice(0, 1000) });
  return embed;
}

async function xemKhach(interaction) {
  const target = interaction.options.getUser("user");
  return respond(interaction, { embeds: [customerEmbed(target.id)] });
}

async function xacMinh(interaction) {
  const target = interaction.options.getUser("user");
  verifyPlayer(target.id, interaction.user.id, now());
  await refreshCard(interaction.guild, target.id).catch(() => {});
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} xác minh player ${mention(target.id)}.`);
  return respond(interaction, `Đã gắn huy hiệu "Đã xác minh" cho ${mention(target.id)}.`);
}

async function boXacMinh(interaction) {
  const target = interaction.options.getUser("user");
  const changed = unverifyPlayer(target.id);
  await refreshCard(interaction.guild, target.id).catch(() => {});
  if (changed) await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} gỡ xác minh của ${mention(target.id)}.`);
  return respond(interaction, changed ? `Đã gỡ huy hiệu xác minh của ${mention(target.id)}.` : `${mention(target.id)} chưa có huy hiệu xác minh.`);
}

const SUBS = { "xac-minh": xacMinh, "bo-xac-minh": boXacMinh, "ghi-chu": ghiChu, "xoa-ghi-chu": xoaGhiChu, "xem-khach": xemKhach, duyet, "khieu-nai": khieuNai, "huy-lich": huyLich, phat, "mo-khoa": moKhoa, cam, "bo-cam": boCam, "tong-ket": tongKet };

export default {
  audited: true,
  data: new SlashCommandBuilder()
    .setName("staff")
    .setDescription("Công cụ cho nhân viên")
    .setDefaultMemberPermissions(0)
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("duyet").setDescription("Hồ sơ player đang chờ duyệt"))
    .addSubcommand((s) => s.setName("khieu-nai").setDescription("Khiếu nại đang mở"))
    .addSubcommand((s) =>
      s
        .setName("huy-lich")
        .setDescription("Huỷ một lịch và hoàn tiền đầy đủ cho khách")
        .addIntegerOption((o) => o.setName("id").setDescription("Số lịch").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("ly-do").setDescription("Lý do").setMaxLength(200)),
    )
    .addSubcommand((s) => s.setName("phat").setDescription("Ghi một cảnh cáo").addUserOption((o) => user(o)).addStringOption(reason))
    .addSubcommand((s) => s.setName("mo-khoa").setDescription("Mở khoá player bị tạm khoá và xoá cảnh cáo").addUserOption((o) => user(o, "Player")))
    .addSubcommand((s) => s.setName("cam").setDescription("Cấm một người dùng").addUserOption((o) => user(o)).addStringOption(reason))
    .addSubcommand((s) => s.setName("bo-cam").setDescription("Bỏ cấm một người dùng").addUserOption((o) => user(o)))
    .addSubcommand((s) => s.setName("xac-minh").setDescription("Gắn huy hiệu Đã xác minh cho player (sau khi bạn đã kiểm tra)").addUserOption((o) => user(o, "Player")))
    .addSubcommand((s) => s.setName("bo-xac-minh").setDescription("Gỡ huy hiệu Đã xác minh của player").addUserOption((o) => user(o, "Player")))
    .addSubcommand((s) => s.setName("tong-ket").setDescription("Tổng kết lịch, doanh thu và việc đang chờ"))
    .addSubcommand((s) => s.setName("xem-khach").setDescription("Xem lịch sử, cảnh cáo, khiếu nại và ghi chú của một người").addUserOption((o) => user(o)))
    .addSubcommand((s) =>
      s.setName("ghi-chu").setDescription("Ghi chú nội bộ về một người (chỉ nhân viên thấy)").addUserOption((o) => user(o)).addStringOption((o) => o.setName("noi-dung").setDescription("Nội dung").setRequired(true).setMaxLength(500)),
    )
    .addSubcommand((s) => s.setName("xoa-ghi-chu").setDescription("Xoá một ghi chú nội bộ").addIntegerOption((o) => o.setName("id").setDescription("Số ghi chú").setRequired(true).setMinValue(1))),

  async execute(interaction) {
    const refusal = gate(interaction, "staff");
    if (refusal) return respond(interaction, refusal);
    await defer(interaction);
    return SUBS[interaction.options.getSubcommand()]?.(interaction);
  },
};
