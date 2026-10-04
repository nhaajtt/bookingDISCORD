import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { couponReport, createCoupon, getCoupon, setCouponActive } from "../domain/coupons.js";
import { formatVnd } from "../domain/pricing.js";
import { DAY, formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS } from "../discord/text.js";

// Owner-only discount codes. A code is paid for from the platform fee of the booking, so a discount can never exceed the fee and
// the player's earnings do not change; the answer says so whenever a code is created.

const int = (o, name, description, { required = false, min = 1 } = {}) => o.setName(name).setDescription(description).setRequired(required).setMinValue(min);

const describe = (c, zone) =>
  `${c.kind === "PERCENT" ? `${c.value}%` : formatVnd(c.value)} | dùng ${c.used}${c.maxUses ? `/${c.maxUses}` : ""} | mỗi người ${c.perUser} lần${c.minPriceVnd ? ` | từ ${formatVnd(c.minPriceVnd)}` : ""}${c.expiresAt ? ` | hết hạn ${formatLocal(c.expiresAt, zone)}` : ""}${c.active ? "" : " | ĐÃ TẮT"}`;

async function tao(interaction) {
  const o = interaction.options;
  const days = o.getInteger("han-ngay");
  const coupon = createCoupon(
    {
      code: o.getString("ma"),
      kind: o.getString("loai"),
      value: o.getInteger("gia-tri"),
      maxUses: o.getInteger("toi-da"),
      perUser: o.getInteger("moi-nguoi") ?? 1,
      minPriceVnd: o.getInteger("gia-toi-thieu") ?? 0,
      expiresAt: days ? now() + days * DAY : null,
      note: o.getString("ghi-chu") ?? "",
    },
    now(),
  );
  return respond(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.ok)
        .setTitle(`Đã tạo mã ${coupon.code}`)
        .setDescription(`${describe(coupon, getSettings().timezone)}\n\nMã được trừ vào phí nền tảng của lịch: mức giảm tối đa bằng đúng phí của lịch đó, phần của player không đổi.`),
    ],
  });
}

async function danhSach(interaction) {
  const rows = couponReport();
  if (!rows.length) return respond(interaction, "Chưa có mã giảm giá nào. Dùng /magiamgia tao.");
  const zone = getSettings().timezone;
  const lines = rows.slice(0, 25).map((r) => {
    const c = getCoupon(r.code);
    return `**${r.code}** ${describe(c, zone)} | đã giảm ${formatVnd(r.discountVnd)}`;
  });
  return respond(interaction, { embeds: [new EmbedBuilder().setColor(COLORS.money).setTitle("Mã giảm giá").setDescription(lines.join("\n"))] });
}

async function bat(interaction, active) {
  const coupon = setCouponActive(interaction.options.getString("ma"), active);
  return respond(interaction, `Mã ${coupon.code} ${active ? "đã bật lại" : "đã tắt, không ai dùng thêm được"}.`);
}

export default {
  audited: true,
  data: new SlashCommandBuilder()
    .setName("magiamgia")
    .setDescription("Mã giảm giá (chỉ chủ server)")
    .setDefaultMemberPermissions(0)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("tao")
        .setDescription("Tạo mã giảm giá mới")
        .addStringOption((o) => o.setName("ma").setDescription("Mã khách sẽ gõ, ví dụ HELLO10").setRequired(true).setMaxLength(20))
        .addStringOption((o) =>
          o.setName("loai").setDescription("Giảm theo phần trăm hay số tiền").setRequired(true).addChoices({ name: "Phần trăm giá", value: "PERCENT" }, { name: "Số tiền cố định (VND)", value: "FIXED" }),
        )
        .addIntegerOption((o) => int(o, "gia-tri", "Số phần trăm (1-100) hoặc số tiền VND", { required: true }))
        .addIntegerOption((o) => int(o, "toi-da", "Tổng số lượt dùng cho tất cả mọi người"))
        .addIntegerOption((o) => int(o, "moi-nguoi", "Số lần mỗi người được dùng (mặc định 1)"))
        .addIntegerOption((o) => int(o, "gia-toi-thieu", "Chỉ áp dụng cho lịch từ số tiền này (VND)", { min: 0 }))
        .addIntegerOption((o) => int(o, "han-ngay", "Hết hạn sau bao nhiêu ngày"))
        .addStringOption((o) => o.setName("ghi-chu").setDescription("Ghi chú cho bạn").setMaxLength(100)),
    )
    .addSubcommand((s) => s.setName("danh-sach").setDescription("Các mã và số tiền đã giảm"))
    .addSubcommand((s) => s.setName("tat").setDescription("Tắt một mã").addStringOption((o) => o.setName("ma").setDescription("Mã").setRequired(true).setMaxLength(20)))
    .addSubcommand((s) => s.setName("bat").setDescription("Bật lại một mã").addStringOption((o) => o.setName("ma").setDescription("Mã").setRequired(true).setMaxLength(20))),

  async execute(interaction) {
    const refusal = gate(interaction, "owner");
    if (refusal) return respond(interaction, refusal);
    await defer(interaction);
    const sub = interaction.options.getSubcommand();
    if (sub === "tao") return tao(interaction);
    if (sub === "danh-sach") return danhSach(interaction);
    return bat(interaction, sub === "bat");
  },
};
