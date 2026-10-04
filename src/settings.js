import { config } from "./config.js";
import { getDb } from "./db.js";
import { isValidTimeZone } from "./domain/time.js";
import { DEFAULT_TIERS } from "./domain/policy.js";

export { DEFAULT_TIERS };

// The one settings document of the one booking server. Every field has a default and the normalizer rebuilds the whole document
// field by field, clamping numbers, so whatever arrives from a command, a modal or a damaged row is cleaned the same way.

const SNOWFLAKE = /^\d{17,20}$/;
const id = (value) => (typeof value === "string" && SNOWFLAKE.test(value) ? value : null);
const text = (value, max) => (typeof value === "string" ? value.replace(/\r/g, "").trim().slice(0, max) : "");
const whole = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Channel and role IDs the Discord layer fills in when it builds the server layout
export const CHANNEL_KEYS = [
  "rulesChannelId",
  "guideChannelId",
  "playersChannelId",
  "applicationsChannelId",
  "bookingsLogChannelId",
  "moneyLogChannelId",
  "disputesChannelId",
  "feedbackChannelId",
  "bookingsCategoryId",
  "roomsCategoryId",
  "ageGateChannelId",
  "applyChannelId",
  "bookChannelId",
  "supportChannelId",
  "playerCornerChannelId",
  "startCategoryId",
  "playerCategoryId",
  "staffCategoryId",
];
export const ROLE_KEYS = ["staffRoleId", "playerRoleId", "trustedPlayerRoleId", "verifiedRoleId", "regularCustomerRoleId"];

// Cancellation tiers: strictly descending hours, refund percent that never rises as the start gets closer, and always a tier that
// starts at 0 hours so every moment has a rule.
function tiers(value) {
  const rows = (Array.isArray(value) && value.length ? value : DEFAULT_TIERS)
    .map((t) => ({ minHoursBefore: whole(t?.minHoursBefore, 0, 720, null), refundPercent: whole(t?.refundPercent, 0, 100, null) }))
    .filter((t) => t.minHoursBefore !== null && t.refundPercent !== null);
  if (!rows.length) rows.push(...DEFAULT_TIERS.map((t) => ({ ...t })));
  if (!rows.some((t) => t.minHoursBefore === 0)) rows.push({ minHoursBefore: 0, refundPercent: 0 });
  rows.sort((a, b) => b.minHoursBefore - a.minHoursBefore);
  const unique = rows.filter((t, i) => i === 0 || t.minHoursBefore !== rows[i - 1].minHoursBefore).slice(0, 6);
  let ceiling = 100;
  return unique.map((t) => {
    ceiling = Math.min(ceiling, t.refundPercent);
    return { minHoursBefore: t.minHoursBefore, refundPercent: ceiling };
  });
}

// Peak-hour surcharges: up to 6 windows, each { days: [0..6], startMin, endMin, percent } on the wall clock of the server's zone.
// The minutes are multiples of 30 because bookings are priced in half-hour slots.
function peaks(value, maxPercent = 100) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const p of value) {
    const days = [...new Set((Array.isArray(p?.days) ? p.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    const startMin = whole(p?.startMin, 0, 1410, null);
    const endMin = whole(p?.endMin, 30, 1440, null);
    const percent = whole(p?.percent, 1, maxPercent, null);
    if (!days.length || startMin === null || endMin === null || percent === null || startMin % 30 || endMin % 30 || endMin <= startMin) continue;
    rows.push({ days, startMin, endMin, percent });
  }
  return rows.slice(0, 6);
}

// Membership plans: pay priceVnd from the wallet, get discountPercent off every booking for `days` days. The discount is taken out of
// the owner's fee (like a coupon), so the player's share never changes. Up to 3 plans.
function memberships(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const rows = [];
  for (const [i, m] of value.entries()) {
    const name = text(m?.name, 30);
    const priceVnd = whole(m?.priceVnd, 10_000, 10_000_000, null);
    const days = whole(m?.days, 1, 365, null);
    const discountPercent = whole(m?.discountPercent, 1, 30, null);
    const planId = /^[a-z0-9]{1,12}$/.test(String(m?.id ?? "")) ? String(m.id) : `m${i + 1}`;
    if (!name || priceVnd === null || days === null || discountPercent === null || seen.has(planId)) continue;
    seen.add(planId);
    rows.push({ id: planId, name, priceVnd: Math.round(priceVnd / 1000) * 1000, days, discountPercent });
  }
  return rows.slice(0, 3);
}

export const DEFAULT_PACKAGES = [
  { amountVnd: 500_000, bonusPercent: 5 },
  { amountVnd: 1_000_000, bonusPercent: 10 },
  { amountVnd: 2_000_000, bonusPercent: 15 },
];

// Wallet top-up packages: pay amountVnd, get amountVnd plus the bonus as credit. Up to 6, sorted by amount, whole thousands.
function packages(value) {
  const source = Array.isArray(value) ? value : DEFAULT_PACKAGES;
  const rows = source
    .filter((p) => Number.isInteger(Number(p?.amountVnd)) && Number(p.amountVnd) >= 10_000)
    .map((p) => ({ amountVnd: Math.round(whole(p.amountVnd, 10_000, 50_000_000, 0) / 1000) * 1000, bonusPercent: whole(p.bonusPercent, 0, 100, 0) }));
  const seen = new Set();
  return rows.filter((p) => !seen.has(p.amountVnd) && seen.add(p.amountVnd)).sort((a, b) => a.amountVnd - b.amountVnd).slice(0, 6);
}

export function defaultSettings(timezone = "Asia/Ho_Chi_Minh") {
  return normalizeSettings({ timezone }, timezone);
}

export function normalizeSettings(raw = {}, fallbackZone = "Asia/Ho_Chi_Minh") {
  const v = raw && typeof raw === "object" ? raw : {};
  const minRate = whole(v.minRateVnd, 1000, 10_000_000, 20_000);
  const maxRate = whole(v.maxRateVnd, 1000, 10_000_000, 500_000);
  const lo = Math.ceil(Math.min(minRate, maxRate) / 1000) * 1000;
  const hi = Math.max(lo, Math.floor(Math.max(minRate, maxRate) / 1000) * 1000);
  const channels = v.channels && typeof v.channels === "object" ? v.channels : {};
  const roles = v.roles && typeof v.roles === "object" ? v.roles : {};
  const trusted = v.trusted && typeof v.trusted === "object" ? v.trusted : {};
  const avg = Number(trusted.minAverage);
  const loyalty = v.loyalty && typeof v.loyalty === "object" ? v.loyalty : {};
  const referral = v.referral && typeof v.referral === "object" ? v.referral : {};
  return {
    timezone: isValidTimeZone(v.timezone) ? v.timezone : isValidTimeZone(fallbackZone) ? fallbackZone : "Asia/Ho_Chi_Minh",
    ownerNotes: text(v.ownerNotes, 1000),
    feePercent: whole(v.feePercent, 0, 50, 10),
    minRateVnd: lo,
    maxRateVnd: hi,
    maxDurationHours: whole(v.maxDurationHours, 1, 12, 4),
    minLeadMin: whole(v.minLeadMin, 0, 1440, 60),
    maxAdvanceDays: whole(v.maxAdvanceDays, 1, 180, 30),
    unpaidExpireMin: whole(v.unpaidExpireMin, 10, 120, 30),
    noShowGraceMin: whole(v.noShowGraceMin, 5, 60, 15),
    reviewWindowHours: whole(v.reviewWindowHours, 1, 168, 24),
    maxActiveBookings: whole(v.maxActiveBookings, 1, 10, 3),
    strikeLimit: whole(v.strikeLimit, 1, 20, 3),
    strikeWindowDays: whole(v.strikeWindowDays, 1, 365, 30),
    disputeFlagCount: whole(v.disputeFlagCount, 2, 50, 3),
    disputeFlagDays: whole(v.disputeFlagDays, 7, 365, 60),
    cancellation: tiers(v.cancellation ?? DEFAULT_TIERS),
    peaks: peaks(v.peaks),
    // Quiet-hour discounts: same windows as the peaks, but they take a percent (at most 50) off the list price, out of the fee
    offpeak: peaks(v.offpeak, 50).slice(0, 4),
    memberships: memberships(v.memberships),
    // Referral: when someone brought by a code finishes their first session worth at least minPriceVnd, both get rewardVnd of wallet
    // credit (0 switches it off). The owner pays for it, it is never taken from a player.
    referral: { rewardVnd: whole(referral.rewardVnd, 0, 500_000, 10_000), minPriceVnd: whole(referral.minPriceVnd, 0, 10_000_000, 100_000) },
    packages: packages(v.packages),
    // Loyalty: a customer earns one point per earnPerVnd spent on completed sessions (0 switches it off); a point is worth
    // pointValueVnd as wallet credit, redeemable from minRedeem points
    loyalty: {
      earnPerVnd: whole(loyalty.earnPerVnd, 0, 1_000_000, 1000),
      pointValueVnd: whole(loyalty.pointValueVnd, 1, 100_000, 50),
      minRedeem: whole(loyalty.minRedeem, 1, 100_000, 100),
    },
    // Longest extension a customer can buy in the room, in 30 minute steps (0 switches it off)
    maxExtendMin: whole(v.maxExtendMin, 0, 240, 120),
    // Waiting list and recurring bookings
    waitlistHoldMin: whole(v.waitlistHoldMin, 5, 240, 30),
    maxSeriesWeeks: whole(v.maxSeriesWeeks, 0, 26, 8),
    trusted: {
      minCompleted: whole(trusted.minCompleted, 1, 1000, 10),
      minAverage: Number.isFinite(avg) ? Math.min(5, Math.max(1, Math.round(avg * 100) / 100)) : 4.5,
      regularCustomerMin: whole(trusted.regularCustomerMin, 1, 1000, 5),
    },
    channels: Object.fromEntries(CHANNEL_KEYS.map((key) => [key, id(channels[key])])),
    roles: Object.fromEntries(ROLE_KEYS.map((key) => [key, id(roles[key])])),
  };
}

function read() {
  const row = getDb().prepare("SELECT data FROM settings WHERE id = 1").get();
  if (!row) return {};
  try {
    return JSON.parse(row.data) ?? {};
  } catch {
    return {};
  }
}

// Stored values are normalized again on the way out, so a damaged row can never leak a bad value
export function getSettings() {
  return normalizeSettings(read(), config.timezone);
}

// Replaces the document with the normalized form of `input`
export function saveSettings(input, now = Date.now()) {
  const clean = normalizeSettings(input, config.timezone);
  getDb()
    .prepare("INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .run(JSON.stringify(clean), now);
  return clean;
}

// Changes only the given top-level fields; nested channels, roles and trusted are merged key by key
export function patchSettings(patch, now = Date.now()) {
  const current = getSettings();
  const next = { ...current, ...patch };
  for (const key of ["channels", "roles", "trusted"]) next[key] = { ...current[key], ...(patch?.[key] ?? {}) };
  return saveSettings(next, now);
}

export const staffRoleId = () => getSettings().roles.staffRoleId;
