// Every rule that refuses something throws a DomainError. `code` is stable and English (tests and the Discord layer branch on it),
// `message` is Vietnamese and safe to show to the person who caused it.

const MESSAGES = {
  ILLEGAL_TRANSITION: (d) => `Lịch này đang ở trạng thái ${d.status}, không thể thực hiện thao tác "${d.action}".`,
  FORBIDDEN_ACTOR: () => "Bạn không có quyền thực hiện thao tác này với lịch này.",
  TOO_EARLY: () => "Chưa đến lúc thực hiện thao tác này.",
  TOO_LATE: () => "Đã quá thời hạn cho thao tác này.",
  NOT_FOUND: (d) => `Không tìm thấy ${d.what ?? "dữ liệu"} yêu cầu.`,
  INVALID_INPUT: (d) => d.message ?? "Dữ liệu không hợp lệ.",

  NOT_ATTESTED: () => "Bạn cần xác nhận mình đủ 18 tuổi trước khi tiếp tục.",
  BLACKLISTED: () => "Tài khoản này không được phép sử dụng dịch vụ.",
  SELF_BOOKING: () => "Bạn không thể tự đặt lịch với chính mình.",
  PLAYER_NOT_ACTIVE: () => "Player này hiện không nhận lịch.",
  GAME_NOT_OFFERED: () => "Player này không chơi game bạn chọn.",
  BAD_START: () => "Giờ bắt đầu phải tròn 30 phút (ví dụ 19:00 hoặc 19:30).",
  IN_PAST: () => "Giờ hẹn đã qua, hãy chọn giờ trong tương lai.",
  TOO_SOON: (d) => `Cần đặt trước ít nhất ${d.minutes} phút.`,
  TOO_FAR: (d) => `Chỉ được đặt trước tối đa ${d.days} ngày.`,
  OUTSIDE_AVAILABILITY: () => "Giờ này nằm ngoài lịch rảnh của player.",
  PLAYER_BUSY: () => "Player đã có lịch khác trong khung giờ này.",
  CUSTOMER_BUSY: () => "Bạn đã có lịch khác trùng khung giờ này.",
  TOO_MANY_ACTIVE: (d) => `Bạn đang có ${d.max} lịch chưa hoàn tất, hãy hoàn tất hoặc huỷ bớt trước khi đặt thêm.`,
  BAD_DURATION: (d) => d.message ?? "Thời lượng không hợp lệ.",
  BAD_RATE: (d) => d.message ?? "Giá không hợp lệ.",

  COUPON_INVALID: () => "Mã giảm giá không đúng hoặc đã bị tắt.",
  COUPON_EXPIRED: () => "Mã giảm giá này đã hết hạn.",
  COUPON_USED_UP: () => "Mã giảm giá này đã hết lượt dùng.",
  COUPON_ALREADY_USED: () => "Bạn đã dùng hết số lần cho mã giảm giá này.",
  COUPON_MIN_PRICE: (d) => `Mã này áp dụng cho lịch từ ${Number(d.min).toLocaleString("vi-VN")} đ trở lên.`,
  COUPON_NO_EFFECT: () => "Mã này không giảm được gì cho lịch này.",
  WALLET_LOW: (d) => `Ví của bạn còn ${Number(d.balance).toLocaleString("vi-VN")} đ, không đủ để thanh toán.`,
  NOT_EXTENDABLE: (d) => d.message ?? "Không thể gia hạn buổi này.",

  SLOT_HELD: () => "Khung giờ này đang được giữ cho người đã đăng ký chờ. Bạn thử lại sau ít phút nhé.",

  UNDERPAID: () => "Số tiền nhận được ít hơn giá của lịch.",
  ORDER_EXISTS: () => "Lịch này đã có link thanh toán đang chờ.",
  SETTLED_ALREADY: () => "Khoản tiền của lịch này đã được trả, không thể tính lại. Hãy xử lý thủ công.",
  PAYOUT_HELD: () => "Khoản trả cho player còn trong thời gian chờ khiếu nại.",
  OPEN_DISPUTE: () => "Lịch này đang có khiếu nại chưa xử lý.",

  NOT_RATEABLE: () => "Chỉ đánh giá được lịch đã hoàn thành.",
  ALREADY_RATED: () => "Lịch này đã được đánh giá rồi.",
  REVIEW_CLOSED: () => "Đã hết thời hạn đánh giá lịch này.",
  BAD_STARS: () => "Số sao phải từ 1 đến 5.",

  ALREADY_PLAYER: () => "Bạn đã là player rồi.",
  PLAYER_SUSPENDED: () => "Tài khoản player này đang bị tạm khoá.",
  BAD_AVAILABILITY: (d) => d.message ?? "Lịch rảnh không hợp lệ.",
};

export class DomainError extends Error {
  constructor(code, details = {}) {
    super(MESSAGES[code] ? MESSAGES[code](details) : code);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const fail = (code, details) => {
  throw new DomainError(code, details);
};
