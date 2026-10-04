import { SlashCommandBuilder } from "discord.js";
import { now } from "../discord/clock.js";
import { defer, respond } from "../discord/respond.js";
import { setLang } from "../i18n.js";

// The language of everything the bot sends you privately: replies, forms, buttons and private messages. Staff channels and public
// panels stay in Vietnamese. Without a choice, English Discord apps get English and everyone else Vietnamese.

export default {
  data: new SlashCommandBuilder()
    .setName("ngonngu")
    .setDescription("Chọn ngôn ngữ cho tin nhắn riêng của bạn / Choose your language")
    .setDMPermission(false)
    .addStringOption((o) => o.setName("ngon-ngu").setDescription("Tiếng Việt hoặc English").setRequired(true).addChoices({ name: "Tiếng Việt", value: "vi" }, { name: "English", value: "en" })),

  async execute(interaction) {
    await defer(interaction);
    const lang = interaction.options.getString("ngon-ngu");
    setLang(interaction.user.id, lang, "manual", now());
    return respond(interaction, lang === "en" ? "Switched to English. Your private messages, buttons and forms will be in English." : "Đã chuyển sang tiếng Việt.");
  },
};
