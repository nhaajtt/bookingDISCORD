import { SlashCommandBuilder } from "discord.js";
import { showQueue } from "../flows/money.js";

export default {
  audited: true,
  data: new SlashCommandBuilder()
    .setName("chuyentien")
    .setDescription("Danh sách khoản cần chuyển cho player và hoàn cho khách (chỉ chủ server)")
    .setDefaultMemberPermissions(0)
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("che-do")
        .setDescription("Cách xem (mặc định: danh sách có nút)")
        .addChoices(
          { name: "Mã QR chuyển khoản cho từng khoản", value: "qr" },
          { name: "Xuất CSV các khoản còn nợ", value: "csv" },
          { name: "Xuất CSV toàn bộ sổ tiền", value: "csv-tat-ca" },
          { name: "Xuất CSV toàn bộ lịch đặt", value: "csv-lich" },
        ),
    ),
  execute: showQueue,
};
