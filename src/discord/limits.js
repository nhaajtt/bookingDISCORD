import { now } from "./clock.js";

// A small sliding-window rate limiter kept in memory. A restart forgets it, which is fine for abuse control.
const hits = new Map();

// hit("book:123", 5, 600_000) -> true when allowed (and counted), false when the person has used up the window
export function hit(key, max, windowMs, at = now()) {
  const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(at);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, list] of hits) if (!list.some((t) => at - t < 3_600_000)) hits.delete(k);
  }
  return true;
}

export const resetLimits = () => hits.clear();

// Buckets used by the handlers: [max, window in ms, message]
export const LIMITS = {
  any: [15, 10_000, "Bạn thao tác nhanh quá, đợi vài giây rồi thử lại nhé."],
  book: [6, 10 * 60_000, "Bạn đặt lịch quá nhiều lần liên tiếp, thử lại sau ít phút nhé."],
  apply: [4, 60 * 60_000, "Bạn gửi hồ sơ quá nhiều lần, thử lại sau một giờ nhé."],
  dispute: [4, 60 * 60_000, "Bạn gửi báo cáo quá nhiều lần, hãy đợi nhân viên xem xét."],
  attest: [8, 10 * 60_000, "Bạn thử quá nhiều lần, đợi vài phút rồi thử lại nhé."],
  rate: [10, 10 * 60_000, "Bạn thao tác quá nhanh, thử lại sau ít phút nhé."],
  avail: [10, 10 * 60_000, "Bạn cập nhật lịch rảnh quá nhanh, thử lại sau ít phút nhé."],
  bank: [6, 10 * 60_000, "Bạn sửa tài khoản quá nhiều lần, thử lại sau ít phút nhé."],
  report: [3, 60 * 60_000, "Bạn gửi báo cáo quá nhiều lần, hãy đợi nhân viên xem xét."],
  coupon: [10, 10 * 60_000, "Bạn nhập mã quá nhiều lần, thử lại sau ít phút nhé."],
  search: [20, 60_000, "Bạn tìm kiếm quá nhanh, đợi vài giây rồi thử lại nhé."],
  wallet: [8, 10 * 60_000, "Bạn thao tác với ví quá nhiều lần, thử lại sau ít phút nhé."],
  extend: [6, 10 * 60_000, "Bạn gia hạn quá nhiều lần, thử lại sau ít phút nhé."],
  waitlist: [10, 10 * 60_000, "Bạn đăng ký chờ quá nhiều lần, thử lại sau ít phút nhé."],
};

// Returns the refusal text, or null when the person may go on
export function limited(userId, bucket) {
  const [max, windowMs, message] = LIMITS[bucket];
  return hit(`${bucket}:${userId}`, max, windowMs) ? null : message;
}
