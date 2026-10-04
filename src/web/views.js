import { getSettings } from "../settings.js";
import { getAvailability, isWithin } from "../domain/availability.js";
import { canTransition, holding } from "../domain/bookings.js";
import { refundFor } from "../domain/policy.js";
import { gameRates } from "../domain/quoting.js";
import { isTrusted } from "../domain/ratings.js";
import { badgesFor, playerStats } from "../domain/stats.js";
import { DAY, MINUTE, localParts, startOfLocalDay } from "../domain/time.js";
import { waitlistHolds } from "../domain/waitlist.js";
import { pendingExtensions } from "../pay/orders.js";
import { getPlayer } from "../domain/players.js";

// What the site is allowed to see. Every object here is built field by field from an allow-list, never by spreading a database row,
// so a column added later (email, bank details, internal notes) cannot leak by accident.

export function publicPlayer(p, extra = {}, now = Date.now(), settings = getSettings()) {
  const rates = gameRates(p.userId);
  const stats = playerStats(p.userId);
  return {
    id: p.userId,
    name: p.displayName,
    bio: p.bio,
    languages: p.languages,
    games: p.games.map((name) => ({ name, rateVnd: rates[name.toLowerCase()] ?? p.rateVnd })),
    rateVnd: p.rateVnd,
    rating: { average: p.average, count: p.ratingCount },
    completed: p.completed,
    hours: stats.hours,
    badges: [...(isTrusted(p, settings) ? ["Uy tín"] : []), ...badgesFor(p, stats, now, settings)],
    photos: p.photos,
    voiceUrl: p.voiceUrl || null,
    ...extra,
  };
}

const pad = (n) => String(n).padStart(2, "0");

// The next `days` local days with the 30-minute starts a customer could book right now: inside the player's weekly hours, outside
// every booking, held slot and paid extension, after the lead time and before the booking horizon. Same rules createBooking applies.
export function freeSlots(playerId, now = Date.now(), settings = getSettings(), days = 14) {
  const hours = getAvailability(playerId);
  const busy = [
    ...holding("player_id", playerId, now, settings).map((b) => [b.start_at, b.start_at + b.duration_min * MINUTE]),
    ...waitlistHolds(playerId, now, settings).map((w) => [w.startAt, w.startAt + w.durationMin * MINUTE]),
    ...pendingExtensions(playerId, now).map((e) => [e.start_at, e.end_at]),
  ];
  const earliest = now + settings.minLeadMin * MINUTE;
  const latest = now + settings.maxAdvanceDays * DAY;
  const first = startOfLocalDay(now, settings.timezone);
  const out = [];
  for (let d = 0; d < days; d += 1) {
    const dayStart = first + d * DAY;
    const parts = localParts(dayStart, settings.timezone);
    const starts = [];
    if (hours.length) {
      for (let at = dayStart; at < dayStart + DAY; at += 30 * MINUTE) {
        if (at < earliest || at > latest) continue;
        if (!isWithin(hours, at, 30, settings.timezone)) continue;
        if (busy.some(([from, to]) => from < at + 30 * MINUTE && at < to)) continue;
        starts.push(at);
      }
    }
    out.push({ date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`, weekday: parts.weekday, starts });
  }
  return out;
}

// A booking as its customer sees it. The rooms' link is only given to the customer, who is on the server.
export function customerBooking(b, now, settings, guildId = null) {
  const player = getPlayer(b.player_id);
  const open = ["AWAITING_PAYMENT", "CONFIRMED"].includes(b.status) && now < b.start_at + settings.noShowGraceMin * MINUTE;
  const refund = b.status === "CONFIRMED" ? refundFor(b, "customer", now, settings.cancellation) : null;
  return {
    id: b.id,
    status: b.status,
    game: b.game,
    startAt: b.start_at,
    durationMin: b.duration_min,
    priceVnd: b.price_vnd,
    listPriceVnd: b.list_price_vnd ?? b.price_vnd,
    discountVnd: b.discount_vnd ?? 0,
    couponCode: b.coupon_code ?? null,
    paidWith: b.paid_with ?? (b.paid_at ? "LINK" : null),
    createdAt: b.created_at,
    expiresAt: b.status === "AWAITING_PAYMENT" ? b.created_at + settings.unpaidExpireMin * MINUTE : null,
    player: { id: b.player_id, name: player?.displayName ?? "Player" },
    canCancel: open && Boolean(canTransition(b.status, "cancel", "customer")),
    refund: refund ? { percent: refund.percent, vnd: refund.refundVnd } : null,
    canRate: b.status === "COMPLETED" && b.rating === null && b.ended_at !== null && now <= b.ended_at + settings.reviewWindowHours * 3_600_000,
    rating: b.rating,
    roomUrl: b.text_channel_id && guildId ? `https://discord.com/channels/${guildId}/${b.text_channel_id}` : null,
  };
}

// A booking as its player sees it: no customer name or id beyond the last four digits, and what the player earns from it
export function playerBooking(b) {
  return {
    id: b.id,
    status: b.status,
    game: b.game,
    startAt: b.start_at,
    durationMin: b.duration_min,
    payoutVnd: b.price_vnd - b.fee_vnd,
    customer: `Khách …${String(b.customer_id).slice(-4)}`,
  };
}
