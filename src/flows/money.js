import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { bankLine, getBank, transferNote, vietQrUrl } from "../domain/bank.js";
import { bookingsCsv, ledgerCsv } from "../domain/export.js";
import { getLedgerRow, markPaid, owedTo, pendingPayouts, pendingRefunds, summary } from "../domain/ledger.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { DomainError } from "../domain/errors.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { mention, nameOf, sendDm } from "../discord/guild.js";
import { moneyLog } from "../discord/moderation.js";
import { defer, followUp, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

// The owner's money queue. The bot never moves money: the owner transfers by hand and presses the button, which records who and when.

const MAX_BUTTONS = 20;
const kindText = (kind) => (kind === "REFUND" ? "hoàn tiền cho khách" : "trả cho player");

const trim = (text, max = 3800) => (text.length > max ? `${text.slice(0, max)}\n...` : text);

// The queue as an embed plus rows of buttons, and the held payouts (listed apart, never with an ordinary pay button)
export function buildQueue(t = now(), settings = getSettings()) {
  const refunds = pendingRefunds();
  const payable = pendingPayouts(t, { settings });
  const held = pendingPayouts(t, { includeHeld: true, settings }).filter((r) => r.releaseAt > t);

  const lines = [];
  lines.push(`**Hoàn tiền cần gửi (${refunds.length})**`);
  if (!refunds.length) lines.push("Không có.");
  for (const r of refunds) lines.push(`#${r.id} | ${formatVnd(r.amount_vnd)} cho ${mention(r.party_user_id)} | lịch #${r.booking_id}${r.note ? ` | ${r.note}` : ""}
  ${bankLine(getBank(r.party_user_id))}`);

  lines.push("", `**Trả cho player được ngay (${payable.length})**`);
  if (!payable.length) lines.push("Không có.");
  const byPlayer = new Map();
  for (const r of payable) byPlayer.set(r.party_user_id, [...(byPlayer.get(r.party_user_id) ?? []), r]);
  for (const [userId, rows] of byPlayer) {
    const now_ = rows.reduce((n, r) => n + r.amount_vnd, 0);
    lines.push(`${mention(userId)}: chuyển ngay ${formatVnd(now_)} (tổng đang nợ kể cả phần giữ: ${formatVnd(owedTo(userId).totalVnd)})`, `  ${bankLine(getBank(userId))}`);
    for (const r of rows) lines.push(`  #${r.id} | ${formatVnd(r.amount_vnd)} | lịch #${r.booking_id}`);
  }

  const embed = new EmbedBuilder().setColor(COLORS.money).setTitle("Việc chuyển tiền").setDescription(trim(lines.join("\n")));
  const totals = summary();
  embed.addFields({
    name: "Sổ cái",
    value: [
      `Trả player: còn nợ ${formatVnd(totals.payoutsOwed.vnd)}, đã trả ${formatVnd(totals.payoutsPaid.vnd)}`,
      `Hoàn khách: còn nợ ${formatVnd(totals.refundsOwed.vnd)}, đã hoàn ${formatVnd(totals.refundsPaid.vnd)}`,
      `Phí giữ lại: ${formatVnd(totals.feeIncome.vnd)}`,
    ].join("\n"),
  });
  if (settings.ownerNotes) embed.addFields({ name: "Ghi chú của chủ server", value: settings.ownerNotes.slice(0, 1000) });
  if (refunds.length + payable.length > MAX_BUTTONS) embed.setFooter({ text: `Chỉ hiện ${MAX_BUTTONS} nút đầu, xử lý xong dùng /chuyentien lại để xem tiếp.` });

  const buttons = [...refunds, ...payable].slice(0, MAX_BUTTONS).map((r) =>
    new ButtonBuilder().setCustomId(`mn:paid:${r.id}`).setStyle(r.kind === "REFUND" ? ButtonStyle.Primary : ButtonStyle.Success).setLabel(`Đã chuyển #${r.id} ${formatVnd(r.amount_vnd)}`.slice(0, 80)),
  );
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));

  let heldView = null;
  if (held.length) {
    const heldEmbed = new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`Đang giữ trong thời gian khiếu nại (${held.length})`)
      .setDescription(trim(held.map((r) => `#${r.id} | ${formatVnd(r.amount_vnd)} cho ${mention(r.party_user_id)} | lịch #${r.booking_id} | Đang giữ đến ${formatLocal(r.releaseAt, settings.timezone)}`).join("\n")))
      .setFooter({ text: "Chỉ ép trả sớm khi thật sự cần. Hành động này được ghi lại." });
    const forceButtons = held.slice(0, 10).map((r) => new ButtonBuilder().setCustomId(`mn:force:${r.id}`).setStyle(ButtonStyle.Danger).setLabel(`Ép trả #${r.id}`));
    const forceRows = [];
    for (let i = 0; i < forceButtons.length; i += 5) forceRows.push(new ActionRowBuilder().addComponents(forceButtons.slice(i, i + 5)));
    heldView = { embeds: [heldEmbed], components: forceRows };
  }
  return { view: { embeds: [embed], components: rows }, heldView };
}

// One embed per row that can be paid now, each with a VietQR image carrying the amount and the note
export function buildQrViews(t = now(), settings = getSettings()) {
  const rows = [...pendingRefunds(), ...pendingPayouts(t, { settings })].slice(0, 30);
  const embeds = rows.map((r) => {
    const bank = getBank(r.party_user_id);
    const embed = new EmbedBuilder()
      .setColor(r.kind === "REFUND" ? COLORS.info : COLORS.ok)
      .setTitle(`#${r.id} | ${formatVnd(r.amount_vnd)} | ${kindText(r.kind)}`)
      .setDescription(`${mention(r.party_user_id)} | lịch #${r.booking_id}
${bank ? `${bankLine(bank)}
Nội dung: ${transferNote(r)}` : "Chưa có tài khoản, nhắc họ dùng /nganhang."}`);
    if (bank) embed.setImage(vietQrUrl(bank, r.amount_vnd, transferNote(r)));
    return embed;
  });
  const views = [];
  for (let i = 0; i < embeds.length; i += 4) views.push({ embeds: embeds.slice(i, i + 4) });
  return views;
}

const csvFile = (name, text) => new AttachmentBuilder(Buffer.from(text, "utf8"), { name });

export async function showQueue(interaction) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const mode = interaction.options?.getString?.("che-do") ?? "hang-doi";
  const settings = getSettings();
  if (mode === "csv") return respond(interaction, { content: "Các khoản còn phải chuyển (mở bằng Excel hoặc Google Sheets).", files: [csvFile("can-chuyen.csv", ledgerCsv({ status: "OWED", settings }))] });
  if (mode === "csv-tat-ca") return respond(interaction, { content: "Toàn bộ sổ tiền trả player và hoàn khách.", files: [csvFile("so-tien.csv", ledgerCsv({ settings }))] });
  if (mode === "csv-lich") return respond(interaction, { content: "Toàn bộ lịch đặt, dùng để đối soát doanh thu.", files: [csvFile("lich-dat.csv", bookingsCsv({ settings }))] });
  if (mode === "qr") {
    const views = buildQrViews();
    if (!views.length) return respond(interaction, "Không có khoản nào cần chuyển ngay.");
    await respond(interaction, views[0]);
    for (const view of views.slice(1)) await followUp(interaction, view);
    return;
  }
  const { view, heldView } = buildQueue();
  await respond(interaction, view);
  if (heldView) await followUp(interaction, heldView);
}

function mustRow(id) {
  const row = getLedgerRow(Number(id));
  if (!row || row.kind === "FEE_INCOME") throw new DomainError("NOT_FOUND", { what: "khoản tiền" });
  return row;
}

const confirmRow = (customId, label, style) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style));

async function askPaid(interaction, [id]) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  const row = mustRow(id);
  if (row.status === "PAID") return respond(interaction, "Khoản này đã được đánh dấu đã chuyển rồi.");
  return respond(interaction, {
    content: `Xác nhận bạn đã chuyển ${formatVnd(row.amount_vnd)} (${kindText(row.kind)}) cho ${mention(row.party_user_id)}, lịch #${row.booking_id}?`,
    components: [confirmRow(`mn:paid:yes:${row.id}`, "Xác nhận đã chuyển", ButtonStyle.Success)],
  });
}

async function afterMark(interaction, row, result, forced) {
  const owner = nameOf(interaction.member ?? interaction.user);
  const amount = formatVnd(row.amount_vnd);
  await moneyLog(interaction.guild, `${forced ? "Ép trả sớm: " : ""}Đã chuyển ${amount} (${kindText(row.kind)}) cho ${mention(row.party_user_id)}, lịch #${row.booking_id}, bởi ${owner} (${mention(interaction.user.id)}).`);
  await sendDm(
    interaction.client,
    row.party_user_id,
    row.kind === "REFUND" ? `Chủ server đã chuyển lại ${amount} cho bạn (lịch #${row.booking_id}).` : `Chủ server đã chuyển ${amount} cho bạn (lịch #${row.booking_id}).`,
  );
  return respond(interaction, { content: `Đã ghi nhận chuyển ${amount} cho ${mention(row.party_user_id)}.`, components: [] });
}

async function doPaid(interaction, [id]) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const row = mustRow(id);
  const result = markPaid(row.id, interaction.user.id, null, now());
  if (result.alreadyPaid) return respond(interaction, { content: "Khoản này đã được đánh dấu đã chuyển trước đó, không thay đổi gì.", components: [] });
  return afterMark(interaction, row, result, false);
}

async function askForce(interaction, [id]) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  const row = mustRow(id);
  if (row.status === "PAID") return respond(interaction, "Khoản này đã được đánh dấu đã chuyển rồi.");
  return respond(interaction, {
    content: `CẢNH BÁO: khoản ${formatVnd(row.amount_vnd)} cho ${mention(row.party_user_id)} (lịch #${row.booking_id}) còn trong thời gian chờ khiếu nại. Trả sớm nghĩa là nếu khách khiếu nại sau đó, bạn phải tự xử lý thủ công. Chỉ tiếp tục nếu chắc chắn.`,
    components: [confirmRow(`mn:force:yes:${row.id}`, `Ép trả ${formatVnd(row.amount_vnd)}`, ButtonStyle.Danger)],
  });
}

async function doForce(interaction, [id]) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const row = mustRow(id);
  const result = markPaid(row.id, interaction.user.id, "ép trả sớm", now(), { force: true });
  if (result.alreadyPaid) return respond(interaction, { content: "Khoản này đã được đánh dấu đã chuyển trước đó, không thay đổi gì.", components: [] });
  return afterMark(interaction, row, result, true);
}

export default {
  auditedPrefixes: ["mn"],
  buttons: {
    "mn:paid": askPaid,
    "mn:paid:yes": doPaid,
    "mn:force": askForce,
    "mn:force:yes": doForce,
  },
};
