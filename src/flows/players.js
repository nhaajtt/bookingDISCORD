import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { applyAsPlayer, approvePlayer, getPlayer, pausePlayer, rejectPlayer, resumePlayer, setAvailabilityText, setMedia, updateProfile } from "../domain/players.js";
import { gameRates, parseGameRates, setGameRates } from "../domain/quoting.js";
import { formatAvailability, getAvailability } from "../domain/availability.js";
import { playerEarnings } from "../domain/summary.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { DomainError } from "../domain/errors.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { refreshCard } from "../discord/cards.js";
import { now } from "../discord/clock.js";
import { channelOf, nameOf, sendDm } from "../discord/guild.js";
import { limited } from "../discord/limits.js";
import { field, modal, parseVnd, rawField } from "../discord/modals.js";
import { audit } from "../discord/moderation.js";
import { defer, respond, send } from "../discord/respond.js";
import { grantRole } from "../discord/roles.js";
import { COLORS } from "../discord/text.js";
import { log } from "../log.js";

// Player lifecycle in Discord: apply -> staff approve or reject -> card -> availability -> pause and resume -> earnings.

export const AVAILABILITY_EXAMPLE = "Ví dụ: T2 19:00-23:00; T7 14:00-22:00; CN 09:00-12:00";
const BAD_RATE = "Giá theo giờ chưa đúng. Gõ số tiền, ví dụ 100000 hoặc 100k.";
const ALREADY_DECIDED = "Hồ sơ này đã được xử lý rồi.";

const refuse = (interaction, text) => respond(interaction, text);

// ---------------------------------------------------------------- apply

function applyModal(interaction, existing) {
  const settings = getSettings();
  return modal("pl:apply:submit", "Đăng ký làm player", [
    { id: "name", label: "Tên hiển thị", max: 32, value: existing?.displayName ?? nameOf(interaction.user) },
    { id: "games", label: "Game hoặc chủ đề (cách nhau dấu phẩy)", max: 120, placeholder: "Liên Quân, LoL, Trò chuyện", value: existing?.games.join(", ") },
    { id: "rate", label: "Giá mỗi giờ (VND)", max: 12, placeholder: `Từ ${settings.minRateVnd} đến ${settings.maxRateVnd}, ví dụ 100000`, value: existing?.rateVnd },
    { id: "bio", label: "Giới thiệu ngắn", max: 500, paragraph: true, value: existing?.bio },
    { id: "languages", label: "Ngôn ngữ", max: 60, placeholder: "Tiếng Việt, English", value: existing?.languages },
  ]);
}

export async function openApply(interaction) {
  const refusal = gate(interaction, "user");
  if (refusal) return refuse(interaction, refusal);
  const existing = getPlayer(interaction.user.id);
  if (existing && ["ACTIVE", "PAUSED"].includes(existing.status)) return refuse(interaction, new DomainError("ALREADY_PLAYER").message);
  return interaction.showModal(applyModal(interaction, existing));
}

export function queueEmbed(player, userId) {
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle("Hồ sơ player chờ duyệt")
    .setDescription(`<@${userId}>`)
    .addFields(
      { name: "Tên hiển thị", value: player.displayName, inline: true },
      { name: "Giá", value: `${formatVnd(player.rateVnd)} / giờ`, inline: true },
      { name: "Ngôn ngữ", value: player.languages || "Chưa ghi", inline: true },
      { name: "Game và chủ đề", value: player.games.join(", ") },
      { name: "Giới thiệu", value: player.bio || "Không có" },
    );
}

export const decisionRow = (userId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pl:approve:${userId}`).setLabel("Duyệt").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pl:reject:${userId}`).setLabel("Từ chối").setStyle(ButtonStyle.Danger),
  );

async function submitApply(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "apply");
  if (refusal) return respond(interaction, refusal);
  const rateVnd = parseVnd(rawField(interaction, "rate"));
  if (rateVnd === null) return respond(interaction, BAD_RATE);
  const userId = interaction.user.id;
  const player = applyAsPlayer(
    { userId, displayName: field(interaction, "name", 32), games: field(interaction, "games", 120), rateVnd, bio: field(interaction, "bio", 500), languages: field(interaction, "languages", 60) },
    now(),
  );
  const queue = await channelOf(interaction.guild, "applicationsChannelId");
  if (queue) await send(queue, { embeds: [queueEmbed(player, userId)], components: [decisionRow(userId)] });
  return respond(interaction, "Đã nhận hồ sơ của bạn. Nhân viên sẽ duyệt sớm, bạn sẽ nhận được thông báo.");
}

// ---------------------------------------------------------------- staff decision

// Shows who decided and when on the queue message, and removes its buttons
async function closeQueueMessage(interaction, text) {
  const message = interaction.message;
  if (!message) return;
  const source = message.embeds?.[0];
  const embed = source ? EmbedBuilder.from(source) : new EmbedBuilder();
  embed.setFooter({ text });
  await message.edit({ embeds: [embed], components: [] }).catch((error) => log.error("application.message_update_failed", { error }));
}

const decidedText = (verb, interaction) => `${verb} bởi ${nameOf(interaction.member ?? interaction.user)} lúc ${formatLocal(now(), getSettings().timezone)}`;

async function approve(interaction, [userId]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return refuse(interaction, refusal);
  await defer(interaction);
  let player;
  try {
    player = approvePlayer(userId, interaction.user.id, now());
  } catch (error) {
    if (error.code === "ILLEGAL_TRANSITION") return respond(interaction, ALREADY_DECIDED);
    throw error;
  }
  const granted = await grantRole(interaction.guild, userId, "player");
  await refreshCard(interaction.guild, userId);
  await sendDm(interaction.client, userId, "Hồ sơ của bạn đã được duyệt. Dùng /lichranh để nhập lịch rảnh.");
  await closeQueueMessage(interaction, decidedText("Đã duyệt", interaction));
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} đã duyệt player ${player.displayName} (<@${userId}>).`);
  return respond(interaction, `Đã duyệt ${player.displayName}.${granted.ok ? "" : " Chưa cấp được role Người chơi, hãy kiểm tra /setup."}`);
}

async function askReject(interaction, [userId]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return refuse(interaction, refusal);
  return interaction.showModal(modal(`pl:reject:submit:${userId}`, "Từ chối hồ sơ", [{ id: "reason", label: "Lý do (người nộp sẽ thấy)", max: 300, paragraph: true }]));
}

async function submitReject(interaction, [userId]) {
  const refusal = gate(interaction, "staff");
  if (refusal) return refuse(interaction, refusal);
  await defer(interaction);
  const reason = field(interaction, "reason", 300);
  try {
    rejectPlayer(userId, interaction.user.id, reason, now());
  } catch (error) {
    if (error.code === "ILLEGAL_TRANSITION") return respond(interaction, ALREADY_DECIDED);
    throw error;
  }
  await sendDm(interaction.client, userId, `Hồ sơ player của bạn chưa được duyệt. Lý do: ${reason || "không ghi"}. Bạn có thể chỉnh lại và gửi lại.`);
  await closeQueueMessage(interaction, decidedText("Đã từ chối", interaction));
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} đã từ chối hồ sơ <@${userId}>: ${reason || "không ghi lý do"}.`);
  return respond(interaction, "Đã từ chối hồ sơ.");
}

// ---------------------------------------------------------------- availability

export async function saveAvailability(interaction, text) {
  const refusal = gate(interaction, "player") ?? limited(interaction.user.id, "avail");
  if (refusal) return respond(interaction, refusal);
  const result = setAvailabilityText(interaction.user.id, text);
  if (!result.ok) return respond(interaction, `Chưa lưu được lịch rảnh:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n${AVAILABILITY_EXAMPLE}`);
  await refreshCard(interaction.guild, interaction.user.id).catch((error) => log.error("card.refresh_failed", { user: interaction.user.id, error }));
  return respond(interaction, `Đã lưu lịch rảnh: ${formatAvailability(result.slots)}. Giờ tính theo múi giờ ${getSettings().timezone}.`);
}

export async function askAvailability(interaction) {
  const refusal = gate(interaction, "player");
  if (refusal) return refuse(interaction, refusal);
  const current = formatAvailability(getAvailability(interaction.user.id));
  return interaction.showModal(modal("pl:avail:submit", "Lịch rảnh hằng tuần", [{ id: "text", label: "Lịch rảnh", max: 400, paragraph: true, placeholder: AVAILABILITY_EXAMPLE, value: current }]));
}

async function submitAvailability(interaction) {
  await defer(interaction);
  return saveAvailability(interaction, rawField(interaction, "text"));
}

// ---------------------------------------------------------------- profile, pause, earnings

export async function askProfile(interaction) {
  const refusal = gate(interaction, "player");
  if (refusal) return refuse(interaction, refusal);
  return interaction.showModal(applyModal(interaction, getPlayer(interaction.user.id)).setCustomId("pl:profile:submit").setTitle("Cập nhật hồ sơ"));
}

async function submitProfile(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "player");
  if (refusal) return respond(interaction, refusal);
  const rateVnd = parseVnd(rawField(interaction, "rate"));
  if (rateVnd === null) return respond(interaction, BAD_RATE);
  updateProfile(interaction.user.id, { displayName: field(interaction, "name", 32), games: field(interaction, "games", 120), rateVnd, bio: field(interaction, "bio", 500), languages: field(interaction, "languages", 60) });
  await refreshCard(interaction.guild, interaction.user.id).catch((error) => log.error("card.refresh_failed", { user: interaction.user.id, error }));
  return respond(interaction, "Đã cập nhật hồ sơ.");
}

// ---------------------------------------------------------------- prices per game and profile media

export async function askRates(interaction) {
  const refusal = gate(interaction, "player");
  if (refusal) return refuse(interaction, refusal);
  const player = getPlayer(interaction.user.id);
  const rates = gameRates(player.userId);
  const current = player.games.filter((g) => rates[g.toLowerCase()] !== undefined).map((g) => `${g} ${rates[g.toLowerCase()]}`).join("\n");
  return interaction.showModal(
    modal("pl:rates:submit", "Giá riêng theo game", [
      { id: "rates", label: `Mỗi dòng một game (mặc định ${formatVnd(player.rateVnd)}/giờ)`, max: 300, paragraph: true, required: false, placeholder: `${player.games[0]} 120000`, value: current },
    ]),
  );
}

async function submitRates(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "player") ?? limited(interaction.user.id, "avail");
  if (refusal) return respond(interaction, refusal);
  const player = getPlayer(interaction.user.id);
  const parsed = parseGameRates(rawField(interaction, "rates"), player.games, parseVnd);
  if (parsed.error) return respond(interaction, parsed.error);
  const count = setGameRates(player.userId, parsed.rates, getSettings());
  await refreshCard(interaction.guild, player.userId).catch((error) => log.error("card.refresh_failed", { user: player.userId, error }));
  return respond(interaction, count ? `Đã lưu giá riêng cho ${count} game. Game không ghi dùng giá mặc định ${formatVnd(player.rateVnd)}/giờ. Lịch đã đặt giữ nguyên giá cũ.` : `Đã xoá giá riêng, mọi game dùng giá ${formatVnd(player.rateVnd)}/giờ.`);
}

export async function askMedia(interaction) {
  const refusal = gate(interaction, "player");
  if (refusal) return refuse(interaction, refusal);
  const p = getPlayer(interaction.user.id);
  return interaction.showModal(
    modal("pl:media:submit", "Ảnh và giọng nói", [
      { id: "photo1", label: "Link ảnh chính (https)", max: 300, required: false, value: p.photos[0] },
      { id: "photo2", label: "Link ảnh 2", max: 300, required: false, value: p.photos[1] },
      { id: "photo3", label: "Link ảnh 3", max: 300, required: false, value: p.photos[2] },
      { id: "voice", label: "Link nghe thử giọng (https)", max: 300, required: false, value: p.voiceUrl },
    ]),
  );
}

async function submitMedia(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "player") ?? limited(interaction.user.id, "avail");
  if (refusal) return respond(interaction, refusal);
  const photos = ["photo1", "photo2", "photo3"].map((id) => rawField(interaction, id)).filter(Boolean);
  const player = setMedia(interaction.user.id, { photos, voiceUrl: rawField(interaction, "voice") });
  await refreshCard(interaction.guild, player.userId).catch((error) => log.error("card.refresh_failed", { user: player.userId, error }));
  return respond(interaction, `Đã lưu ${player.photos.length} ảnh${player.voiceUrl ? " và link giọng nói" : ""}. Hồ sơ của bạn đã được cập nhật.`);
}

export async function pause(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "player");
  if (refusal) return respond(interaction, refusal);
  pausePlayer(interaction.user.id);
  await refreshCard(interaction.guild, interaction.user.id).catch(() => {});
  return respond(interaction, "Đã chuyển sang trạng thái nghỉ. Lịch đã nhận vẫn giữ nguyên; huỷ lịch đã nhận sẽ hoàn tiền cho khách và bạn bị 1 cảnh cáo.");
}

export async function resume(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "player");
  if (refusal) return respond(interaction, refusal);
  resumePlayer(interaction.user.id);
  await refreshCard(interaction.guild, interaction.user.id).catch(() => {});
  return respond(interaction, "Bạn đã nhận lịch trở lại.");
}

export async function earnings(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "player");
  if (refusal) return respond(interaction, refusal);
  const e = playerEarnings(interaction.user.id, now());
  const next = e.nextBookingAt ? `, gần nhất ${formatLocal(e.nextBookingAt, getSettings().timezone)}` : "";
  return respond(
    interaction,
    [
      `Đã hoàn thành: ${e.completed} buổi.`,
      `Đánh giá: ${e.ratingCount ? `${e.average} sao (${e.ratingCount} lượt)` : "chưa có"}.`,
      `Chờ chuyển: ${formatVnd(e.owedVnd)} (đang giữ đến hết thời gian khiếu nại: ${formatVnd(e.heldVnd)}).`,
      `Đã nhận: ${formatVnd(e.paidVnd)}.`,
      `Buổi tới: ${e.upcomingCount}${next}.`,
    ].join("\n"),
  );
}

export default {
  auditedPrefixes: ["pl:approve", "pl:reject"],
  buttons: {
    "pl:apply": openApply,
    "pl:approve": approve,
    "pl:reject": askReject,
    "pl:pause": pause,
    "pl:resume": resume,
  },
  modals: {
    "pl:apply:submit": submitApply,
    "pl:reject:submit": submitReject,
    "pl:avail:submit": submitAvailability,
    "pl:profile:submit": submitProfile,
    "pl:rates:submit": submitRates,
    "pl:media:submit": submitMedia,
  },
};
