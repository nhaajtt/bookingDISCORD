import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { listPlayers } from "../domain/players.js";
import { SORTS, searchPlayers } from "../domain/search.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

// Finding the right player: by game, price, rating and language, who is free right now, in the order you want.

const SORT_NAMES = {
  diem: "Điểm đánh giá cao nhất",
  "gia-tang": "Giá thấp đến cao",
  "gia-giam": "Giá cao đến thấp",
  gio: "Chơi nhiều giờ nhất",
  moi: "Mới tham gia",
};

export function resultLine(p, zone, t) {
  const rating = p.ratingCount ? `${p.average}★ (${p.ratingCount})` : "chưa có đánh giá";
  const free = p.freeNow ? "đang rảnh" : p.nextFreeAt ? `rảnh từ ${formatLocal(p.nextFreeAt, zone)}` : "chưa có giờ trống";
  return `**${p.displayName}** | ${rating} | ${formatVnd(p.rateVnd)}/giờ | ${p.games.join(", ")} | ${free}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName("timplayer")
    .setDescription("Tìm player theo game, giá, điểm đánh giá, ngôn ngữ hoặc đang rảnh")
    .setDMPermission(false)
    .addStringOption((o) => o.setName("game").setDescription("Game hoặc chủ đề").setAutocomplete(true).setMaxLength(40))
    .addIntegerOption((o) => o.setName("gia-toi-da").setDescription("Giá mỗi giờ tối đa (VND)").setMinValue(1000))
    .addNumberOption((o) => o.setName("diem-toi-thieu").setDescription("Điểm đánh giá trung bình tối thiểu (1 đến 5)").setMinValue(1).setMaxValue(5))
    .addStringOption((o) => o.setName("ngon-ngu").setDescription("Ngôn ngữ, ví dụ English").setMaxLength(30))
    .addBooleanOption((o) => o.setName("dang-ranh").setDescription("Chỉ hiện người đang rảnh ngay bây giờ"))
    .addStringOption((o) => o.setName("sap-xep").setDescription("Cách sắp xếp").addChoices(...SORTS.map((value) => ({ name: SORT_NAMES[value], value })))),

  async autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").toLowerCase();
    const games = [...new Set(listPlayers({ status: "ACTIVE" }).flatMap((p) => p.games))].filter((g) => g.toLowerCase().includes(typed)).slice(0, 25);
    return interaction.respond(games.map((g) => ({ name: g.slice(0, 100), value: g.slice(0, 100) })));
  },

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "search");
    if (refusal) return respond(interaction, refusal);
    const o = interaction.options;
    const sort = o.getString("sap-xep") ?? "diem";
    const settings = getSettings();
    const results = searchPlayers(
      {
        game: o.getString("game"),
        maxRateVnd: o.getInteger("gia-toi-da"),
        minRating: o.getNumber?.("diem-toi-thieu") ?? null,
        language: o.getString("ngon-ngu"),
        freeNow: Boolean(o.getBoolean("dang-ranh")),
        sort,
        excludeUserId: interaction.user.id,
        limit: 10,
      },
      now(),
      settings,
    );
    if (!results.length) return respond(interaction, "Không có player nào khớp. Thử bỏ bớt điều kiện lọc nhé.");
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(`Tìm thấy ${results.length} player`)
      .setDescription(results.map((p, i) => `${i + 1}. ${resultLine(p, settings.timezone, now())}`).join("\n"))
      .setFooter({ text: `Sắp xếp: ${SORT_NAMES[sort] ?? SORT_NAMES.diem}. Bấm số để đặt lịch.` });
    const buttons = results.map((p, i) => new ButtonBuilder().setCustomId(`pl:book:${p.userId}`).setLabel(`${i + 1}. ${p.displayName}`.slice(0, 80)).setStyle(ButtonStyle.Primary));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return respond(interaction, { embeds: [embed], components: rows });
  },
};
