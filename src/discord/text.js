import { EmbedBuilder } from "discord.js";
import { formatLocal } from "../domain/time.js";
import { formatVnd } from "../domain/pricing.js";

// Vietnamese wording and small formatters shared by the handlers and jobs.

export const COLORS = { info: 0x5865f2, ok: 0x2ecc71, warn: 0xf39c12, bad: 0xe74c3c, money: 0x1abc9c };

export const STATUS_VI = Object.freeze({
  AWAITING_PAYMENT: "Chờ thanh toán",
  CONFIRMED: "Đã xác nhận",
  IN_PROGRESS: "Đang diễn ra",
  COMPLETED: "Hoàn thành",
  CANCELLED: "Đã huỷ",
  NO_SHOW_PLAYER: "Player vắng mặt",
  NO_SHOW_CUSTOMER: "Khách vắng mặt",
  DISPUTED: "Đang khiếu nại",
  EXPIRED: "Hết hạn thanh toán",
});

export const CANCELLABLE = Object.freeze(["AWAITING_PAYMENT", "CONFIRMED"]);

// 60 -> "1 giờ", 90 -> "1,5 giờ"
export const durationText = (min) => `${String(min / 60).replace(".", ",")} giờ`;

// "#12 | T2 05/10 19:00 | 1 giờ | 100.000 đ | Đã xác nhận"
export const bookingSummary = (b, timeZone) =>
  `#${b.id} | ${formatLocal(b.start_at, timeZone)} | ${durationText(b.duration_min)} | ${formatVnd(b.price_vnd)} | ${STATUS_VI[b.status] ?? b.status}`;

// The cancellation tiers as sentences, so the guide always shows what the code will really do
export function cancellationLines(tiers) {
  return tiers.map((tier, i) => {
    const refund = tier.refundPercent > 0 ? `hoàn ${tier.refundPercent}%` : "không hoàn tiền";
    if (i === 0) return tier.minHoursBefore === 0 ? `Huỷ bất cứ lúc nào: ${refund}.` : `Huỷ trước giờ hẹn từ ${tier.minHoursBefore} giờ trở lên: ${refund}.`;
    const above = tiers[i - 1].minHoursBefore;
    return tier.minHoursBefore === 0 ? `Huỷ trong vòng ${above} giờ trước giờ hẹn: ${refund}.` : `Huỷ trước giờ hẹn từ ${tier.minHoursBefore} đến dưới ${above} giờ: ${refund}.`;
  });
}

// What the owner reads at a glance: used by the staff summary and the scheduled digest
export function summaryEmbed(summary, settings, title) {
  const zone = settings.timezone;
  const day = (d) => `${d.count} lịch, dự kiến ${formatVnd(d.expectedVnd)}`;
  return new EmbedBuilder()
    .setColor(COLORS.money)
    .setTitle(title)
    .setDescription(`Tính đến ${formatLocal(summary.generatedAt, zone)} (múi giờ ${zone}).`)
    .addFields(
      { name: "Hôm nay", value: day(summary.today), inline: true },
      { name: "7 ngày tới", value: day(summary.next7Days), inline: true },
      {
        name: "Doanh thu trong kỳ",
        value: [
          `Tổng: ${formatVnd(summary.period.revenueVnd)} (${summary.period.bookings} lịch)`,
          `Phí giữ lại: ${formatVnd(summary.period.feeVnd)}`,
          `Phần của player: ${formatVnd(summary.period.playerShareVnd)}`,
          `Đã ghi hoàn: ${formatVnd(summary.period.refundedVnd)}`,
        ].join("\n"),
      },
      { name: "Hồ sơ chờ duyệt", value: String(summary.pendingApplications.length), inline: true },
      { name: "Khiếu nại đang mở", value: String(summary.openDisputes.length), inline: true },
      ...(summary.wallet?.liabilityVnd || summary.wallet?.bonusGivenVnd
        ? [{ name: "Ví khách", value: `Còn nợ dịch vụ: ${formatVnd(summary.wallet.liabilityVnd)} (${summary.wallet.people} người), đã tặng thêm khi nạp: ${formatVnd(summary.wallet.bonusGivenVnd)}` }]
        : []),
      {
        name: "Việc chuyển tiền",
        value: [
          `Trả player được ngay: ${summary.payouts.payableCount} khoản, ${formatVnd(summary.payouts.payableVnd)}`,
          `Trả player đang giữ: ${summary.payouts.heldCount} khoản, ${formatVnd(summary.payouts.heldVnd)}`,
          `Hoàn tiền khách: ${summary.refunds.count} khoản, ${formatVnd(summary.refunds.vnd)}`,
        ].join("\n"),
      },
    );
}
