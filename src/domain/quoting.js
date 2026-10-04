import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { DURATION_STEP_MIN, roundFee, validateDuration, validateRate } from "./pricing.js";
import { MINUTE, localParts } from "./time.js";
import { couponDiscount } from "./coupons.js";

// The price of one booking, in whole dong:
//   rate     the player's price for that game (a per-game price if they set one, otherwise their hourly rate)
//   list     the rate for every half hour, plus the peak-hour surcharge of the half hours that fall inside a peak window
//   fee      the owner's fee, on the list price
//   coupon   taken out of the fee only (see coupons.js), so the player's share never changes
// With no peak window and no coupon this is exactly rate * duration / 60, as before.

export const gameRates = (playerId) => Object.fromEntries(getDb().prepare("SELECT game, rate_vnd FROM player_games WHERE player_id = ?").all(playerId).map((r) => [r.game.toLowerCase(), r.rate_vnd]));

// The hourly rate for a game: the per-game price when there is one, the player's base rate otherwise
export function rateFor(player, game) {
  return gameRates(player.userId)[String(game ?? "").trim().toLowerCase()] ?? player.rateVnd;
}

// The surcharge percent that applies to the half hour starting at `ms` (the highest when windows overlap), 0 outside every window
export function peakPercentAt(ms, settings = getSettings()) {
  if (!settings.peaks.length) return 0;
  const p = localParts(ms, settings.timezone);
  return settings.peaks.filter((w) => w.days.includes(p.weekday) && p.minuteOfDay >= w.startMin && p.minuteOfDay < w.endMin).reduce((m, w) => Math.max(m, w.percent), 0);
}

// quoteBooking({ player, game, startAt, durationMin, couponCode?, userId?, now? }, settings?) ->
//   { rateVnd, durationMin, listPriceVnd, surchargeVnd, discountVnd, priceVnd, feeVnd, playerShareVnd, coupon, couponCapped }
export function quoteBooking({ player, game, startAt, durationMin, couponCode = null, userId = null, now = Date.now() }, settings = getSettings()) {
  const rateVnd = rateFor(player, game);
  validateRate(rateVnd, null);
  validateDuration(durationMin, { maxDurationMin: settings.maxDurationHours * 60 });
  const baseVnd = (rateVnd * durationMin) / 60;
  let listPriceVnd = baseVnd;
  if (settings.peaks.length && Number.isFinite(startAt)) {
    listPriceVnd = 0;
    for (let at = startAt; at < startAt + durationMin * MINUTE; at += DURATION_STEP_MIN * MINUTE) {
      listPriceVnd += Math.floor((rateVnd * (100 + peakPercentAt(at, settings)) + 100) / 200);
    }
  }
  const surchargeVnd = listPriceVnd - baseVnd;
  const listFeeVnd = roundFee(listPriceVnd, settings.feePercent);
  let discountVnd = 0;
  let coupon = null;
  let couponCapped = false;
  if (couponCode) {
    if (!userId) fail("COUPON_INVALID");
    const found = couponDiscount(couponCode, { userId, listPriceVnd, feeVnd: listFeeVnd, now });
    ({ discountVnd, coupon } = found);
    couponCapped = found.capped;
  }
  const priceVnd = listPriceVnd - discountVnd;
  const feeVnd = listFeeVnd - discountVnd;
  return { rateVnd, durationMin, listPriceVnd, surchargeVnd, discountVnd, priceVnd, feeVnd, playerShareVnd: priceVnd - feeVnd, coupon, couponCapped };
}

// setGameRates(userId, { "Liên Quân": 120000, ... }, settings?) replaces the player's per-game prices; a game that is not listed uses the base rate
export function setGameRates(userId, rates, settings = getSettings()) {
  const db = getDb();
  const clean = [];
  for (const [game, rate] of Object.entries(rates)) {
    const name = String(game).trim();
    if (!name) continue;
    clean.push([name, validateRate(rate, { minRateVnd: settings.minRateVnd, maxRateVnd: settings.maxRateVnd })]);
  }
  db.prepare("DELETE FROM player_games WHERE player_id = ?").run(userId);
  const insert = db.prepare("INSERT OR REPLACE INTO player_games (player_id, game, rate_vnd) VALUES (?, ?, ?)");
  for (const [game, rate] of clean) insert.run(userId, game, rate);
  return clean.length;
}

// "Liên Quân 120000" per line (also "120k") -> { rates } or { error }; only games the player offers are accepted
export function parseGameRates(text, games, parseVnd) {
  const rates = {};
  for (const line of String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(.*\S)\s+([0-9][0-9.,]*\s*(?:k|nghin|nghìn|đ|vnd)?)$/i.exec(line);
    const rate = m ? parseVnd(m[2]) : null;
    const game = m ? games.find((g) => g.toLowerCase() === m[1].trim().toLowerCase()) : null;
    if (!m || rate === null) return { error: `Dòng "${line.slice(0, 40)}" chưa đúng. Viết tên game rồi giá, ví dụ: Liên Quân 120000` };
    if (!game) return { error: `"${m[1].trim().slice(0, 30)}" không nằm trong danh sách game của bạn (${games.join(", ")}).` };
    rates[game] = rate;
  }
  return { rates };
}

// ---------------------------------------------------------------- peak windows as text

const DAY_LABELS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const dayIndex = (token) => {
  const t = token.toLowerCase();
  if (t === "cn") return 0;
  const m = /^t([2-7])$/.exec(t);
  return m ? Number(m[1]) - 1 : null;
};
const clock = (text) => {
  const m = /^(\d{1,2})(?::|h)(\d{2})?$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  return minute > 59 || hour > 24 || (hour === 24 && minute) ? null : hour * 60 + minute;
};
const pad = (n) => String(n).padStart(2, "0");

export const PEAK_EXAMPLE = "Mỗi dòng một khung: các ngày, giờ, phần trăm tăng. Ví dụ:\nT6 T7 CN 19:00-23:00 +20\nT2-T5 20:00-22:00 +10";

// parsePeaks(text) -> { peaks } or { error }
export function parsePeaks(text) {
  const peaks = [];
  for (const line of String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const bad = { error: `Dòng "${line.slice(0, 40)}" chưa đúng. ${PEAK_EXAMPLE}` };
    const m = /^(.+?)\s+(\d{1,2}(?::|h)\d{0,2}\s*-\s*\d{1,2}(?::|h)\d{0,2})\s+\+?(\d{1,3})\s*%?$/.exec(line);
    if (!m) return bad;
    const days = new Set();
    for (const token of m[1].split(/[\s,]+/).filter(Boolean)) {
      const range = /^(t[2-7]|cn)-(t[2-7]|cn)$/i.exec(token);
      if (range) {
        const order = [1, 2, 3, 4, 5, 6, 0];
        const a = order.indexOf(dayIndex(range[1]));
        const b = order.indexOf(dayIndex(range[2]));
        if (a > b) return bad;
        for (let i = a; i <= b; i += 1) days.add(order[i]);
      } else {
        const d = dayIndex(token);
        if (d === null) return bad;
        days.add(d);
      }
    }
    const [from, to] = m[2].split("-").map(clock);
    if (from === null || to === null || to <= from || from % 30 || to % 30) return { error: `Giờ trong dòng "${line.slice(0, 40)}" phải tròn 30 phút và kết thúc sau khi bắt đầu.` };
    const percent = Number(m[3]);
    if (percent < 1 || percent > 100) return { error: "Phần trăm tăng phải từ 1 đến 100." };
    peaks.push({ days: [...days].sort(), startMin: from, endMin: to, percent });
  }
  if (peaks.length > 6) return { error: "Tối đa 6 khung giờ cao điểm." };
  return { peaks };
}

export const formatPeaks = (peaks) =>
  peaks
    .map((p) => {
      const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => p.days.includes(d));
      return `${order.map((d) => DAY_LABELS[d]).join(" ")} ${pad(Math.floor(p.startMin / 60))}:${pad(p.startMin % 60)}-${pad(Math.floor(p.endMin / 60))}:${pad(p.endMin % 60)} +${p.percent}`;
    })
    .join("\n");

// "500000 +5" per line -> { packages } or { error }
export const PACKAGE_EXAMPLE = "Mỗi dòng một gói: số tiền nạp, rồi phần trăm tặng thêm. Ví dụ:\n500000 +5\n1000000 +10";
export function parsePackages(text, parseVnd) {
  const packages = [];
  for (const line of String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\S+)\s+\+?(\d{1,3})\s*%?$/.exec(line);
    const amountVnd = m ? parseVnd(m[1]) : null;
    if (!m || amountVnd === null || amountVnd < 10_000) return { error: `Dòng "${line.slice(0, 40)}" chưa đúng. ${PACKAGE_EXAMPLE}` };
    if (Number(m[2]) > 100) return { error: "Phần trăm tặng thêm tối đa 100." };
    packages.push({ amountVnd, bonusPercent: Number(m[2]) });
  }
  if (!packages.length) return { error: `Chưa có gói nào. ${PACKAGE_EXAMPLE}` };
  if (packages.length > 6) return { error: "Tối đa 6 gói." };
  return { packages };
}
