import { getDb, transaction } from "../db.js";
import { localParts } from "./time.js";

// A slot is { weekday, startMin, endMin }: weekday 0 is Sunday, minutes count from local midnight, endMin 1440 means midnight.
// Slots never cross midnight; a player who is free over midnight enters two slots (T2 20:00-24:00 and T3 00:00-02:00).
// A booking that crosses midnight is accepted when both parts fall inside slots (see isWithin).

export const SLOT_STEP_MIN = 30;
const LABELS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MAX_TEXT = 400;
const MAX_RANGES_PER_DAY = 4;

const plain = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

const pad = (n) => String(n).padStart(2, "0");
export const formatMinutes = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

function parseClock(raw) {
  const m = /^(\d{1,2})\s*(?::|h)\s*(\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 60 + minute;
}

// Sorts and merges overlapping or touching slots of the same day, so "09:00-12:00" and "12:00-15:00" count as one stretch
export function mergeSlots(slots) {
  const out = [];
  const sorted = [...slots].sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  for (const slot of sorted) {
    const last = out[out.length - 1];
    if (last && last.weekday === slot.weekday && slot.startMin <= last.endMin) last.endMin = Math.max(last.endMin, slot.endMin);
    else out.push({ weekday: slot.weekday, startMin: slot.startMin, endMin: slot.endMin });
  }
  return out;
}

// "T2 19:00-23:00; T7 14:00-22:00; CN 09:00-12:00" -> { ok, slots, errors }. Accepts T2..T7, CN, "thu 2", "thứ 2", "chủ nhật",
// "19h", "19h30", several ranges per day separated by commas, and ";" or new lines between days. Errors are Vietnamese sentences.
export function parseAvailability(input) {
  const errors = [];
  const raw = typeof input === "string" ? input.replace(/[\u2013\u2014]/g, "-").trim() : "";
  if (!raw) return { ok: false, slots: [], errors: ["Chưa nhập lịch rảnh. Ví dụ: T2 19:00-23:00; T7 14:00-22:00; CN 09:00-12:00"] };
  if (raw.length > MAX_TEXT) return { ok: false, slots: [], errors: [`Lịch rảnh quá dài (tối đa ${MAX_TEXT} ký tự).`] };

  const slots = [];
  for (const entryRaw of raw.split(/[;\n]+/)) {
    const entry = entryRaw.trim();
    if (!entry) continue;
    const m = /^(cn|chu\s*nhat|(?:thu|th|t)\s*[2-7])(?![0-9])\s*(.*)$/.exec(plain(entry));
    if (!m) {
      errors.push(`Không hiểu ngày trong "${entry}". Dùng T2 đến T7 hoặc CN.`);
      continue;
    }
    const dayText = m[1].replace(/\s+/g, "");
    const weekday = dayText.startsWith("cn") || dayText.startsWith("chu") ? 0 : Number(dayText.slice(-1)) - 1;
    const ranges = m[2].split(",").map((r) => r.trim()).filter(Boolean);
    if (!ranges.length) {
      errors.push(`Thiếu giờ trong "${entry}". Ví dụ: ${LABELS[weekday]} 19:00-23:00`);
      continue;
    }
    for (const range of ranges) {
      const parts = range.split("-");
      const startMin = parts.length === 2 ? parseClock(parts[0]) : null;
      const endMin = parts.length === 2 ? parseClock(parts[1]) : null;
      if (startMin === null || endMin === null) errors.push(`Giờ "${range}" của ${LABELS[weekday]} không hợp lệ. Dùng dạng 19:00-23:00.`);
      else if (endMin <= startMin) errors.push(`${LABELS[weekday]} ${range}: giờ kết thúc phải sau giờ bắt đầu. Nếu rảnh qua nửa đêm, tách thành hai ngày (T2 20:00-24:00; T3 00:00-02:00).`);
      else if (startMin % SLOT_STEP_MIN || endMin % SLOT_STEP_MIN) errors.push(`${LABELS[weekday]} ${range}: giờ phải tròn ${SLOT_STEP_MIN} phút.`);
      else slots.push({ weekday, startMin, endMin });
    }
  }

  const merged = mergeSlots(slots);
  for (let day = 0; day < 7; day += 1) {
    if (merged.filter((s) => s.weekday === day).length > MAX_RANGES_PER_DAY) errors.push(`${LABELS[day]} có quá nhiều khung giờ (tối đa ${MAX_RANGES_PER_DAY}).`);
  }
  if (!errors.length && !merged.length) errors.push("Chưa có khung giờ nào.");
  return { ok: errors.length === 0, slots: errors.length ? [] : merged, errors };
}

// The same text parseAvailability accepts, Monday first
export function formatAvailability(slots) {
  const merged = mergeSlots(slots);
  const parts = [];
  for (const day of DISPLAY_ORDER) {
    const ranges = merged.filter((s) => s.weekday === day).map((s) => `${formatMinutes(s.startMin)}-${formatMinutes(s.endMin)}`);
    if (ranges.length) parts.push(`${LABELS[day]} ${ranges.join(", ")}`);
  }
  return parts.join("; ");
}

// True when the whole booking [startAt, startAt + durationMin) lies inside the slots, read on the wall clock of `timeZone`.
// A slot that ends exactly when the booking ends is fine. A booking that crosses local midnight is split at midnight and each
// part must be covered by that day's slots. Duration is counted in elapsed minutes, which is exact for zones without daylight saving.
export function isWithin(slots, startAt, durationMin, timeZone) {
  if (!Number.isFinite(startAt) || !Number.isInteger(durationMin) || durationMin <= 0) return false;
  const merged = mergeSlots(slots);
  const start = localParts(startAt, timeZone);
  let day = start.weekday;
  let from = start.minuteOfDay;
  let remaining = durationMin;
  while (remaining > 0) {
    const to = Math.min(1440, from + remaining);
    if (!merged.some((s) => s.weekday === day && s.startMin <= from && s.endMin >= to)) return false;
    remaining -= to - from;
    day = (day + 1) % 7;
    from = 0;
  }
  return true;
}

export function getAvailability(playerId) {
  return getDb()
    .prepare("SELECT weekday, start_min AS startMin, end_min AS endMin FROM availability WHERE player_id = ? ORDER BY weekday, start_min")
    .all(playerId)
    .map((row) => ({ ...row }));
}

// Replaces the player's whole weekly schedule
export function setAvailability(playerId, slots) {
  const merged = mergeSlots(slots);
  transaction(() => {
    const db = getDb();
    db.prepare("DELETE FROM availability WHERE player_id = ?").run(playerId);
    const insert = db.prepare("INSERT INTO availability (player_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)");
    for (const s of merged) insert.run(playerId, s.weekday, s.startMin, s.endMin);
  });
  return merged;
}
