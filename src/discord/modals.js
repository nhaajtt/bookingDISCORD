import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { sanitizeText } from "../domain/ratings.js";

// modal("pl:apply:submit", "Đăng ký", [{ id, label, max, paragraph, required, value, placeholder }])
export function modal(customId, title, inputs) {
  const built = new ModalBuilder().setCustomId(customId).setTitle(title.slice(0, 45));
  for (const input of inputs) {
    const field = new TextInputBuilder()
      .setCustomId(input.id)
      .setLabel(input.label.slice(0, 45))
      .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(input.required !== false)
      .setMaxLength(input.max ?? 100);
    if (input.placeholder) field.setPlaceholder(input.placeholder.slice(0, 100));
    if (input.value) field.setValue(String(input.value).slice(0, input.max ?? 100));
    built.addComponents(new ActionRowBuilder().addComponents(field));
  }
  return built;
}

// A modal field with user text, cleaned (no mentions, no links, no control characters) and cut to a length
export const field = (interaction, id, max = 100) => sanitizeText(interaction.fields.getTextInputValue(id), max);

// A modal field kept as typed apart from trimming, for values that are parsed (a rate, a date) rather than shown
export const rawField = (interaction, id) => String(interaction.fields.getTextInputValue(id) ?? "").trim();

// "100000", "100.000", "100,000", "100k", "100 nghìn" -> 100000; null when it is not a number
export function parseVnd(text) {
  const t = String(text ?? "").toLowerCase().trim().replace(/đ|vnd|vnđ/g, "").trim();
  const thousand = /^(\d+(?:[.,]\d+)?)\s*(?:k|nghin|nghìn)$/.exec(t);
  if (thousand) return Math.round(Number(thousand[1].replace(",", ".")) * 1000);
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(t)) return Number(t.replace(/[.,]/g, ""));
  if (/^\d+$/.test(t)) return Number(t);
  return null;
}
