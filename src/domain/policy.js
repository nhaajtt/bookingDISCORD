import { HOUR } from "./time.js";

// More than 24 hours ahead refunds all, 24 to 2 hours half, under 2 hours nothing
export const DEFAULT_TIERS = [
  { minHoursBefore: 24, refundPercent: 100 },
  { minHoursBefore: 2, refundPercent: 50 },
  { minHoursBefore: 0, refundPercent: 0 },
];

// Tiers are sorted by minHoursBefore, largest first. The first tier whose threshold is reached applies, so exactly 24 hours before
// the start still earns the 24 hour tier (the boundary favours the customer). At or after the start the last tier applies.
export function tierFor(tiers, hoursBefore) {
  return tiers.find((t) => hoursBefore >= t.minHoursBefore) ?? tiers[tiers.length - 1];
}

// refundFor(booking, cancelledBy, now, tiers?) -> { refundVnd, keptVnd, percent, tier, strike }
// cancelledBy is customer, player, staff or system. A player, staff or system cancellation always refunds everything; only the
// customer is held to the tiers. A booking that was never paid refunds nothing because nothing was received.
export function refundFor(booking, cancelledBy, now = Date.now(), tiers = DEFAULT_TIERS) {
  const priceVnd = booking.price_vnd;
  if (booking.status === "AWAITING_PAYMENT") return { refundVnd: 0, keptVnd: 0, percent: 0, tier: null, strike: false };
  const hoursBefore = (booking.start_at - now) / HOUR;
  let tier = null;
  let percent = 100;
  if (cancelledBy === "customer") {
    tier = tierFor(tiers, hoursBefore);
    percent = tier.refundPercent;
  }
  const refundVnd = Math.floor((priceVnd * percent) / 100);
  return { refundVnd, keptVnd: priceVnd - refundVnd, percent, tier, strike: cancelledBy === "player" };
}
