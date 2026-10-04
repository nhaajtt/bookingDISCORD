import { SlashCommandBuilder } from "discord.js";
import { config } from "../config.js";
import { activateLicense, licenseStatus } from "../license.js";
import { formatLocal } from "../domain/time.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { isOwner } from "../discord/permissions.js";
import { defer, respond } from "../discord/respond.js";
import { log } from "../log.js";

// Activates a license key for this server (multi-server mode). It is the one command a server without a license may use, so it runs
// outside the server's own data: it only touches the license database.

export default {
  data: new SlashCommandBuilder()
    .setName("kichhoat")
    .setDescription("Kích hoạt hoặc gia hạn giấy phép cho server này (chỉ quản trị viên)")
    .setDefaultMemberPermissions(0)
    .setDMPermission(false)
    .addStringOption((o) => o.setName("ma").setDescription("Mã kích hoạt, dạng BK-XXXXXX-XXXXXX-XXXXXX").setRequired(true).setMaxLength(40)),

  async execute(interaction) {
    await defer(interaction);
    if (!config.multiTenant) return respond(interaction, "Bot đang chạy ở chế độ một server nên không cần kích hoạt.");
    if (!isOwner(interaction.member, interaction.user.id)) return respond(interaction, "Chỉ quản trị viên của server mới kích hoạt được.");
    const tooMany = limited(interaction.user.id, "attest");
    if (tooMany) return respond(interaction, tooMany);
    const result = activateLicense(interaction.options.getString("ma"), interaction.guildId, now());
    if (!result.ok) return respond(interaction, result.reason);
    const status = licenseStatus(interaction.guildId, now());
    log.info("license.activated", { guild: interaction.guildId, plan: result.license.plan });
    return respond(
      interaction,
      `Đã kích hoạt gói ${status.plan}, dùng đến ${formatLocal(status.expiresAt, "Asia/Ho_Chi_Minh")} (còn ${status.daysLeft} ngày). Bước tiếp theo: chạy /setup để dựng các kênh và role.`,
    );
  },
};
