import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { ATTEST_PHRASE } from "../domain/attestations.js";
import { formatVnd } from "../domain/pricing.js";
import { getSettings } from "../settings.js";
import { COLORS, cancellationLines } from "./text.js";

// The fixed messages the layout builder posts. The footer text is a marker: the builder finds its own message by it and edits it
// in place, so running /setup again (or the daily refresh) never posts a duplicate.

export const MARKERS = Object.freeze({
  rules: "booking:rules",
  age: "booking:age",
  guide: "booking:guide",
  apply: "booking:apply",
  book: "booking:book",
  support: "booking:support",
});

const embed = (marker, color, title, lines) => new EmbedBuilder().setColor(color).setTitle(title).setDescription(lines.join("\n")).setFooter({ text: marker });
const button = (id, label, style = ButtonStyle.Primary) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style));

export function rulesPanel() {
  return {
    embeds: [
      embed(MARKERS.rules, COLORS.info, "Luật của server", [
        "**1. Chỉ dành cho người từ 18 tuổi trở lên.** Bạn phải xác nhận ở kênh xác nhận 18+ trước khi xem các kênh khác.",
        "**2. Nội dung lành mạnh.** Server chỉ để chơi game cùng nhau và trò chuyện. Không nội dung khiêu dâm, gợi dục, bạo lực hay phân biệt đối xử. Vi phạm sẽ bị cấm.",
        "**3. Đặt lịch qua bot.** Mọi thanh toán đều qua link của bot. Không chuyển tiền riêng, không nhận tiền ngoài hệ thống.",
        "**4. Không chuyển cuộc trò chuyện sang tin nhắn riêng.** Player và khách chỉ trò chuyện trong phòng hẹn để nhân viên hỗ trợ được khi có sự cố.",
        "**5. Tôn trọng nhau.** Không quấy rối, không đòi thông tin cá nhân, không gửi link lạ.",
        "**6. Có sự cố thì báo.** Bấm Báo cáo sự cố trong phòng hẹn hoặc nhắn nhân viên. Bot không đọc nội dung tin nhắn, nên cần bạn báo.",
      ]),
    ],
  };
}

export function agePanel() {
  return {
    embeds: [
      embed(MARKERS.age, COLORS.warn, "Xác nhận đủ 18 tuổi", [
        "Server này chỉ dành cho người từ 18 tuổi trở lên và chỉ có nội dung lành mạnh.",
        `Bấm nút bên dưới rồi gõ đúng câu: **${ATTEST_PHRASE}**. Đây là lời xác nhận của chính bạn, được lưu cùng thời gian xác nhận.`,
      ]),
    ],
    components: [button("age:open", "Tôi đã đủ 18 tuổi", ButtonStyle.Success)],
  };
}

export function guidePanel(settings = getSettings()) {
  return {
    embeds: [
      embed(MARKERS.guide, COLORS.info, "Hướng dẫn đặt lịch", [
        "**Cách đặt:** vào kênh đặt lịch bấm Đặt lịch, hoặc bấm Đặt lịch ở hồ sơ player, hoặc dùng lệnh /datlich. Chọn game, ngày giờ và thời lượng.",
        `**Giá:** theo giờ của từng player, từ ${formatVnd(settings.minRateVnd)} đến ${formatVnd(settings.maxRateVnd)} mỗi giờ. Thời lượng tối đa ${settings.maxDurationHours} giờ, đặt trước ít nhất ${settings.minLeadMin} phút và tối đa ${settings.maxAdvanceDays} ngày.`,
        `**Thanh toán:** bot gửi link thanh toán, bạn có ${settings.unpaidExpireMin} phút để trả, sau đó lịch tự huỷ. Tiền được ghi nhận tự động, không cần gửi bill.`,
        "**Phòng hẹn:** 10 phút trước giờ hẹn bot mở phòng chat và voice riêng chỉ có bạn, player và nhân viên hỗ trợ. Player vắng mặt thì bạn được hoàn 100%.",
        "**Huỷ lịch:**",
        ...cancellationLines(settings.cancellation).map((line) => `- ${line}`),
        "**Hoàn tiền:** bot không giữ tiền. Khoản hoàn được ghi nhận và chủ server chuyển lại cho bạn, thường trong vài ngày làm việc.",
        `**Đánh giá và khiếu nại:** trong ${settings.reviewWindowHours} giờ sau buổi hẹn bạn có thể đánh giá hoặc báo sự cố. Tiền của player được giữ lại cho đến hết thời gian này.`,
        "**An toàn:** chỉ chơi game và trò chuyện lành mạnh. Có vấn đề, bấm Báo cáo sự cố.",
      ]),
    ],
  };
}

export function applyPanel(settings = getSettings()) {
  return {
    embeds: [
      embed(MARKERS.apply, COLORS.info, "Đăng ký làm player", [
        "Bạn muốn cùng chơi game hoặc trò chuyện với khách và nhận thù lao? Bấm nút bên dưới để gửi hồ sơ.",
        `Cần: đủ 18 tuổi (đã xác nhận), tên hiển thị, game hoặc chủ đề, giá theo giờ (từ ${formatVnd(settings.minRateVnd)} đến ${formatVnd(settings.maxRateVnd)}), giới thiệu ngắn và ngôn ngữ.`,
        "Nhân viên sẽ duyệt hồ sơ. Sau khi được duyệt, dùng lệnh /lichranh để nhập lịch rảnh.",
        "Nội dung chỉ gồm chơi game và trò chuyện lành mạnh.",
      ]),
    ],
    components: [button("pl:apply", "Đăng ký làm player")],
  };
}

export function bookPanel() {
  return {
    embeds: [
      embed(MARKERS.book, COLORS.ok, "Đặt lịch", [
        "Bấm nút bên dưới, chọn player, rồi điền game, ngày giờ và thời lượng. Bot sẽ gửi link thanh toán riêng cho bạn.",
        "Xem các lịch của bạn bằng lệnh /lichcuatoi.",
      ]),
    ],
    components: [button("bk:pick", "Đặt lịch")],
  };
}

export function supportPanel() {
  return {
    embeds: [
      embed(MARKERS.support, COLORS.info, "Hỗ trợ", [
        "Cần giúp đỡ? Nhắn câu hỏi của bạn ở đây, nhân viên sẽ trả lời. Đừng gửi mật khẩu, số tài khoản hay thông tin cá nhân.",
        "Sự cố trong một buổi hẹn: bấm Báo cáo sự cố trong phòng hẹn, khoản tiền của buổi đó sẽ được giữ lại cho đến khi xử lý.",
      ]),
    ],
  };
}
