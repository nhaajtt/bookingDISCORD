import { SlashCommandBuilder } from "discord.js";
import { askAvailability, saveAvailability } from "../flows/players.js";
import { openPicker } from "../flows/availability.js";
import { defer } from "../discord/respond.js";

export default {
  data: new SlashCommandBuilder()
    .setName("lichranh")
    .setDescription("Nhập lịch rảnh hằng tuần của bạn (dành cho player)")
    .setDMPermission(false)
    .addStringOption((o) => o.setName("lich").setDescription("Ví dụ: T2 19:00-23:00; T7 14:00-22:00; CN 09:00-12:00").setMaxLength(400))
    .addBooleanOption((o) => o.setName("chon").setDescription("Chọn ngày và giờ bằng menu thay vì gõ chữ")),

  // With the text given it is saved at once; without, a form opens, filled with the current schedule
  async execute(interaction) {
    if (interaction.options.getBoolean("chon")) {
      await defer(interaction);
      return openPicker(interaction);
    }
    const text = interaction.options.getString("lich");
    if (text === null || text === undefined) return askAvailability(interaction);
    await defer(interaction);
    return saveAvailability(interaction, text);
  },
};
