import { SlashCommandBuilder } from "discord.js";
import { askMedia, askProfile, askRates, openApply, pause, resume } from "../flows/players.js";

export default {
  data: new SlashCommandBuilder()
    .setName("player")
    .setDescription("Hồ sơ player")
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("dang-ky").setDescription("Đăng ký làm player"))
    .addSubcommand((s) => s.setName("thong-tin").setDescription("Sửa tên, game, giá, giới thiệu của bạn"))
    .addSubcommand((s) => s.setName("gia-theo-game").setDescription("Đặt giá riêng cho từng game"))
    .addSubcommand((s) => s.setName("anh-gioi-thieu").setDescription("Thêm ảnh và giọng nói giới thiệu (link)"))
    .addSubcommand((s) => s.setName("tam-nghi").setDescription("Tạm nghỉ, không nhận lịch mới"))
    .addSubcommand((s) => s.setName("nhan-lai").setDescription("Nhận lịch trở lại")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "dang-ky") return openApply(interaction);
    if (sub === "thong-tin") return askProfile(interaction);
    if (sub === "gia-theo-game") return askRates(interaction);
    if (sub === "anh-gioi-thieu") return askMedia(interaction);
    if (sub === "tam-nghi") return pause(interaction);
    return resume(interaction);
  },
};
