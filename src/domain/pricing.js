import { fail } from "./errors.js";

// All money is whole dong. A rate is dong per hour in multiples of 1000 and a duration is a multiple of 30 minutes, so
// rate * duration / 60 is always a whole number (a multiple of 500) and nothing is ever rounded away or invented.

export const DURATION_STEP_MIN = 30;
export const RATE_STEP_VND = 1000;
export const FEE_STEP_VND = 1000;

export function limitsFrom(settings) {
  return { minRateVnd: settings.minRateVnd, maxRateVnd: settings.maxRateVnd, maxDurationMin: settings.maxDurationHours * 60 };
}

export function validateRate(rateVnd, limits = null) {
  if (!Number.isInteger(rateVnd) || rateVnd <= 0 || rateVnd % RATE_STEP_VND) {
    fail("BAD_RATE", { message: `Giá theo giờ phải là số nguyên, chia hết cho ${RATE_STEP_VND.toLocaleString("vi-VN")} đ.` });
  }
  if (limits && (rateVnd < limits.minRateVnd || rateVnd > limits.maxRateVnd)) {
    fail("BAD_RATE", { message: `Giá theo giờ phải từ ${limits.minRateVnd.toLocaleString("vi-VN")} đến ${limits.maxRateVnd.toLocaleString("vi-VN")} đ.` });
  }
  return rateVnd;
}

export function validateDuration(durationMin, limits = null) {
  if (!Number.isInteger(durationMin) || durationMin < DURATION_STEP_MIN || durationMin % DURATION_STEP_MIN) {
    fail("BAD_DURATION", { message: `Thời lượng phải là bội số của ${DURATION_STEP_MIN} phút, tối thiểu ${DURATION_STEP_MIN} phút.` });
  }
  if (limits && durationMin > limits.maxDurationMin) {
    fail("BAD_DURATION", { message: `Thời lượng tối đa là ${limits.maxDurationMin / 60} giờ.` });
  }
  return durationMin;
}

// Platform fee: feePercent of the price, rounded half up to a thousand dong, never above the price
export function roundFee(priceVnd, feePercent) {
  if (!Number.isInteger(feePercent) || feePercent < 0 || feePercent > 100) fail("INVALID_INPUT", { message: "Phần trăm phí không hợp lệ." });
  const fee = Math.floor((priceVnd * feePercent + 50_000) / 100_000) * FEE_STEP_VND;
  return Math.min(fee, priceVnd);
}

// quote(rateVnd, durationMin, feePercent, limits?) -> { rateVnd, durationMin, priceVnd, feeVnd, playerShareVnd }
// What the customer pays is priceVnd; feeVnd stays with the owner and playerShareVnd is what the owner owes the player.
export function quote(rateVnd, durationMin, feePercent, limits = null) {
  validateRate(rateVnd, limits);
  validateDuration(durationMin, limits);
  const priceVnd = (rateVnd * durationMin) / 60;
  const feeVnd = roundFee(priceVnd, feePercent);
  return { rateVnd, durationMin, priceVnd, feeVnd, playerShareVnd: priceVnd - feeVnd };
}

// parseDurationText("1.5") -> 90. For the booking modal. A bare number up to 12 is hours ("1", "1,5", "2"); a bare number above 12 is
// minutes ("90"); "2h", "1h30", "90p", "90 phut" and "90 min" are explicit. Returns null when it is not a duration.
// The result is only parsed, not validated: validateDuration decides whether it is allowed.
export function parseDurationText(input) {
  const text = String(input ?? "").toLowerCase().trim().replace(",", ".");
  let m = /^(\d+)\s*h\s*(\d{1,2})?$/.exec(text);
  if (m) return Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0);
  m = /^(\d+(?:\.\d+)?)\s*(?:p|ph|phut|phút|min|m)$/.exec(text);
  if (m) return Math.round(Number(m[1]));
  m = /^(\d+(?:\.\d+)?)\s*(?:g|gio|giờ|hr|hours?)?$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return /[a-zà-ỹ]/.test(text) || n <= 12 ? Math.round(n * 60) : Math.round(n);
}

// 100000 -> "100.000 đ"
export const formatVnd = (vnd) => `${Math.round(vnd).toLocaleString("vi-VN")} đ`;
