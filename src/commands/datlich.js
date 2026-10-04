import { SlashCommandBuilder } from "discord.js";
import { listPlayers } from "../domain/players.js";
import { showPicker, startBooking } from "../flows/booking.js";

export default {
  data: new SlashCommandBuilder()
    .setName("datlich")
    .setDescription("Đặt lịch chơi game hoặc trò chuyện với một player")
    .setDMPermission(false)
    .addUserOption((o) => o.setName("player").setDescription("Player bạn muốn đặt (bỏ trống để chọn từ danh sách)"))
    .addStringOption((o) => o.setName("game").setDescription("Game hoặc chủ đề").setAutocomplete(true).setMaxLength(40)),

  // The games of the chosen player, or of every active player when none is chosen yet
  async autocomplete(interaction) {
    const typed = String(interaction.options.getFocused() ?? "").toLowerCase();
    const playerId = interaction.options.get("player")?.value;
    const players = listPlayers({ status: "ACTIVE" }).filter((p) => !playerId || p.userId === playerId);
    const games = [...new Set(players.flatMap((p) => p.games))].filter((g) => g.toLowerCase().includes(typed)).slice(0, 25);
    return interaction.respond(games.map((g) => ({ name: g.slice(0, 100), value: g.slice(0, 100) })));
  },

  async execute(interaction) {
    const player = interaction.options.getUser("player");
    if (!player) return showPicker(interaction);
    return startBooking(interaction, player.id, interaction.options.getString("game"));
  },
};
