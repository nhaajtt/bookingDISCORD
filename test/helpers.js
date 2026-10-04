// Import this file first in every test: it sets the environment before any src module reads it.
process.env.DISCORD_TOKEN = "test-token";
process.env.CLIENT_ID = "100000000000000001";
process.env.GUILD_ID = "100000000000000002";
process.env.DATA_DIR = ":memory:";
process.env.TIMEZONE = "Asia/Ho_Chi_Minh";
process.env.PAYOS_CLIENT_ID = "client-id";
process.env.PAYOS_API_KEY = "api-key";
process.env.PAYOS_CHECKSUM_KEY = "checksum-key";
// Tests never read a real .env: everything else the code looks at is blanked
for (const key of ["OWNER_IDS", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PAYMENT_PROVIDER", "DISCORD_CLIENT_SECRET", "SESSION_SECRET", "WEB_SITE_URL", "WEB_DISCORD_INVITE", "WEB_PORT", "WEB_PUBLIC_URL", "DASHBOARD_TOKEN", "METRICS_TOKEN", "MULTI_TENANT", "LICENSE_REQUIRED", "ALERT_WEBHOOK_URL", "RETURN_URL", "LOG_LEVEL", "LOG_FORMAT"]) process.env[key] = "";

const { closeDb, getDb } = await import("../src/db.js");
const { saveSettings, getSettings } = await import("../src/settings.js");
const attestations = await import("../src/domain/attestations.js");
const players = await import("../src/domain/players.js");
const bookings = await import("../src/domain/bookings.js");

export { getDb, getSettings, saveSettings };

// Vietnam is UTC+7 all year. vn(2026, 10, 5, 19, 0) is Monday 5 October 2026, 19:00 there.
export const vn = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 7, mi);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// Monday 2026-10-05 10:00 local
export const NOW = vn(2026, 10, 5, 10, 0);

export const ALL_WEEK = "T2 00:00-24:00; T3 00:00-24:00; T4 00:00-24:00; T5 00:00-24:00; T6 00:00-24:00; T7 00:00-24:00; CN 00:00-24:00";

export function fresh() {
  closeDb();
  getDb();
  saveSettings({});
}

export function makePlayer(userId = "p1", { rateVnd = 100_000, games = ["Liên Quân", "LoL"], availability = ALL_WEEK, status = "ACTIVE" } = {}) {
  attestations.attest(userId, NOW - DAY);
  players.applyAsPlayer({ userId, displayName: `Player ${userId}`, games, rateVnd, bio: "xin chào", languages: "vi" }, NOW - DAY);
  players.setAvailabilityText(userId, availability);
  if (status !== "PENDING") players.approvePlayer(userId, "staff1", NOW - DAY);
  if (status === "PAUSED") players.pausePlayer(userId);
  return players.getPlayer(userId);
}

export function makeCustomer(userId = "c1") {
  attestations.attest(userId, NOW - DAY);
  return userId;
}

// A booking 3 hours after NOW (13:00 local), one hour long unless said otherwise
export function book({ customerId = "c1", playerId = "p1", game = "Liên Quân", startAt = NOW + 3 * HOUR, durationMin = 60, now = NOW, couponCode = null } = {}) {
  return bookings.createBooking({ customerId, playerId, game, startAt, durationMin, couponCode }, now);
}

// A booking that is paid and confirmed
export function confirmed(options = {}) {
  const b = book(options);
  return bookings.pay(b.id, options.now ?? NOW, b.price_vnd).booking;
}

export function ledgerRows(bookingId) {
  return getDb().prepare("SELECT * FROM ledger WHERE booking_id = ? ORDER BY id").all(bookingId);
}

export const sum = (rows) => rows.reduce((n, r) => n + r.amount_vnd, 0);
