import { SlashCommandBuilder } from "discord.js";
import { earnings } from "../flows/players.js";

export default {
  data: new SlashCommandBuilder().setName("thunhap").setDescription("Xem thu nhập, khoản chờ chuyển và lịch sắp tới của bạn (dành cho player)").setDMPermission(false),
  execute: earnings,
};
