import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { formatAvailability, getAvailability, setAvailability } from "../domain/availability.js";
import { setAvailabilityText } from "../domain/players.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { refreshCard } from "../discord/cards.js";
import { limited } from "../discord/limits.js";
import { respond } from "../discord/respond.js";
import { log } from "../log.js";

// Entering weekly hours with menus instead of typing: pick the days, the first and last hour, add the range, repeat. The choices live
// in the custom ids of the menus (days as a bit mask, hours as numbers), so nothing is stored between clicks and nothing a forged id
// says can touch anyone else: the schedule that changes is always the one of the person who clicked.
// Hours are whole hours here; half hours are typed with /lichranh.

const DAYS = [
  [1, "Thứ 2"], [2, "Thứ 3"], [3, "Thứ 4"], [4, "Thứ 5"], [5, "Thứ 6"], [6, "Thứ 7"], [0, "Chủ nhật"],
];
const hourLabel = (h) => `${String(h).padStart(2, "0")}:00`;

const parseState = (text) => {
  const [mask, from, to] = String(text ?? "0.-1.-1").split(".").map(Number);
  return { mask: Number.isInteger(mask) && mask >= 0 && mask < 128 ? mask : 0, from: Number.isInteger(from) && from >= 0 && from <= 23 ? from : -1, to: Number.isInteger(to) && to >= 1 && to <= 24 ? to : -1 };
};
const stateText = ({ mask, from, to }) => `${mask}.${from}.${to}`;

export function pickerView(userId, state, note = "") {
  const text = formatAvailability(getAvailability(userId));
  const s = stateText(state);
  const days = new StringSelectMenuBuilder()
    .setCustomId(`av:day:${s}`)
    .setPlaceholder("Chọn các ngày")
    .setMinValues(0)
    .setMaxValues(7)
    .addOptions(DAYS.map(([d, label]) => ({ label, value: String(d), default: Boolean(state.mask & (1 << d)) })));
  const from = new StringSelectMenuBuilder()
    .setCustomId(`av:from:${s}`)
    .setPlaceholder("Từ giờ")
    .addOptions(Array.from({ length: 24 }, (_, h) => ({ label: hourLabel(h), value: String(h), default: state.from === h })));
  const to = new StringSelectMenuBuilder()
    .setCustomId(`av:to:${s}`)
    .setPlaceholder("Đến giờ")
    .addOptions(Array.from({ length: 24 }, (_, i) => ({ label: hourLabel(i + 1), value: String(i + 1), default: state.to === i + 1 })));
  const ready = state.mask > 0 && state.from >= 0 && state.to > state.from;
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`av:add:${s}`).setLabel("Thêm khung giờ").setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId("av:clear").setLabel("Xoá toàn bộ lịch").setStyle(ButtonStyle.Danger),
  );
  return {
    content: [note, `Lịch rảnh hiện tại: ${text || "chưa có"}`, `Giờ tính theo múi giờ ${getSettings().timezone}. Chọn ngày, giờ bắt đầu, giờ kết thúc rồi bấm Thêm khung giờ. Muốn giờ rưỡi, dùng /lichranh và gõ chữ.`].filter(Boolean).join("\n"),
    components: [new ActionRowBuilder().addComponents(days), new ActionRowBuilder().addComponents(from), new ActionRowBuilder().addComponents(to), buttons],
  };
}

export async function openPicker(interaction) {
  const refusal = gate(interaction, "player");
  if (refusal) return respond(interaction, refusal);
  return respond(interaction, pickerView(interaction.user.id, parseState(null)));
}

async function change(interaction, args, apply) {
  const refusal = gate(interaction, "player");
  if (refusal) return respond(interaction, refusal);
  const state = parseState(args[0]);
  apply(state, interaction.values ?? []);
  return interaction.update(pickerView(interaction.user.id, state));
}

const onDays = (interaction, args) => change(interaction, args, (s, values) => (s.mask = values.reduce((m, v) => (Number.isInteger(Number(v)) && v >= 0 && v <= 6 ? m | (1 << Number(v)) : m), 0)));
const onFrom = (interaction, args) => change(interaction, args, (s, values) => (s.from = Number.isInteger(Number(values[0])) ? Number(values[0]) : -1));
const onTo = (interaction, args) => change(interaction, args, (s, values) => (s.to = Number.isInteger(Number(values[0])) ? Number(values[0]) : -1));

async function onAdd(interaction, args) {
  const refusal = gate(interaction, "player") ?? limited(interaction.user.id, "avail");
  if (refusal) return respond(interaction, refusal);
  const state = parseState(args[0]);
  if (!(state.mask > 0 && state.from >= 0 && state.to > state.from)) return interaction.update(pickerView(interaction.user.id, state, "Chọn ngày và giờ bắt đầu, kết thúc (sau giờ bắt đầu) trước nhé."));
  const added = DAYS.map(([d]) => d).filter((d) => state.mask & (1 << d)).map((weekday) => ({ weekday, startMin: state.from * 60, endMin: state.to * 60 }));
  const merged = [...getAvailability(interaction.user.id), ...added];
  const result = setAvailabilityText(interaction.user.id, formatAvailability(merged));
  if (!result.ok) return interaction.update(pickerView(interaction.user.id, state, `Chưa thêm được: ${result.errors[0]}`));
  await refreshCard(interaction.guild, interaction.user.id).catch((error) => log.error("card.refresh_failed", { user: interaction.user.id, error }));
  return interaction.update(pickerView(interaction.user.id, state, "Đã thêm khung giờ."));
}

async function onClear(interaction) {
  const refusal = gate(interaction, "player") ?? limited(interaction.user.id, "avail");
  if (refusal) return respond(interaction, refusal);
  setAvailability(interaction.user.id, []);
  await refreshCard(interaction.guild, interaction.user.id).catch((error) => log.error("card.refresh_failed", { user: interaction.user.id, error }));
  return interaction.update(pickerView(interaction.user.id, parseState(null), "Đã xoá toàn bộ lịch rảnh. Bạn chưa nhận được lịch cho đến khi thêm khung giờ mới."));
}

export default {
  buttons: { "av:add": onAdd, "av:clear": onClear },
  selects: { "av:day": onDays, "av:from": onFrom, "av:to": onTo },
};
