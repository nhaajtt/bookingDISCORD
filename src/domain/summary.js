import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { DAY, startOfLocalDay } from "./time.js";
import { listBookings, listOpenDisputes } from "./bookings.js";
import { listPlayers } from "./players.js";
import { pendingPayouts, pendingRefunds } from "./ledger.js";
import { bonusGiven, walletLiability } from "./wallet.js";

const OPEN = ["AWAITING_PAYMENT", "CONFIRMED", "IN_PROGRESS"];
const total = (rows) => rows.reduce((n, r) => n + r.amount_vnd, 0);

// ownerSummary(now, { periodDays?, settings? }) -> the owner's weekly picture
//   today / next7Days   bookings (open ones) that start today, and from tomorrow for seven days, with counts and expected price
//   period              the last `periodDays` local days up to now (default 7): money that stayed with the platform and the players
//                       (revenueVnd = fee + player payouts of settled bookings), the fee alone, refunds, number of settled bookings
//   pendingApplications players waiting for approval
//   payouts / refunds   what the owner can hand over now, and what is still on hold
//   openDisputes        disputes waiting for staff
export function ownerSummary(now = Date.now(), { periodDays = 7, settings = getSettings() } = {}) {
  const midnight = startOfLocalDay(now, settings.timezone);
  const tomorrow = midnight + DAY;
  const between = (from, to) => listBookings({ statuses: OPEN, from, to, limit: 500 });
  const describe = (bookings) => ({ count: bookings.length, expectedVnd: bookings.reduce((n, b) => n + b.price_vnd, 0), bookings });

  const since = midnight - (periodDays - 1) * DAY;
  const ledgerRows = getDb().prepare("SELECT kind, amount_vnd, booking_id FROM ledger WHERE created_at >= ? AND created_at <= ?").all(since, now);
  const ofKind = (kind) => ledgerRows.filter((r) => r.kind === kind);
  const feeVnd = total(ofKind("FEE_INCOME"));
  const payoutVnd = total(ofKind("PLAYER_PAYOUT"));

  const payable = pendingPayouts(now, { settings });
  const held = pendingPayouts(now, { includeHeld: true, settings }).filter((r) => r.releaseAt > now);
  const refunds = pendingRefunds();

  return {
    generatedAt: now,
    today: describe(between(midnight, tomorrow)),
    next7Days: describe(between(tomorrow, tomorrow + 7 * DAY)),
    period: {
      since,
      until: now,
      revenueVnd: feeVnd + payoutVnd,
      feeVnd,
      playerShareVnd: payoutVnd,
      refundedVnd: total(ofKind("REFUND")),
      bookings: new Set(ledgerRows.map((r) => r.booking_id)).size,
    },
    pendingApplications: listPlayers({ status: "PENDING" }).map((p) => ({ userId: p.userId, displayName: p.displayName, games: p.games, createdAt: p.createdAt })),
    payouts: { payableCount: payable.length, payableVnd: total(payable), heldCount: held.length, heldVnd: total(held) },
    refunds: { count: refunds.length, vnd: total(refunds) },
    wallet: { liabilityVnd: walletLiability().vnd, people: walletLiability().people, bonusGivenVnd: bonusGiven() },
    openDisputes: listOpenDisputes(),
  };
}

// playerEarnings(userId, now, settings?) -> what a player has earned and is owed
//   owedVnd (payable now), heldVnd (waiting out the complaint window), paidVnd (already handed over), lifetimeVnd (all three)
export function playerEarnings(userId, now = Date.now(), settings = getSettings()) {
  const owed = pendingPayouts(now, { includeHeld: true, settings }).filter((r) => r.party_user_id === userId);
  const payable = owed.filter((r) => r.releaseAt <= now);
  const held = owed.filter((r) => r.releaseAt > now);
  const paid = getDb().prepare("SELECT COALESCE(SUM(amount_vnd), 0) AS vnd, COUNT(*) AS n FROM ledger WHERE kind = 'PLAYER_PAYOUT' AND status = 'PAID' AND party_user_id = ?").get(userId);
  const player = getDb().prepare("SELECT completed, rating_sum, rating_count FROM players WHERE user_id = ?").get(userId);
  const upcoming = listBookings({ playerId: userId, statuses: ["CONFIRMED"], from: now, limit: 500 });
  const owedVnd = total(payable);
  const heldVnd = total(held);
  return {
    userId,
    owedVnd,
    heldVnd,
    paidVnd: Number(paid.vnd),
    lifetimeVnd: owedVnd + heldVnd + Number(paid.vnd),
    payoutsPaid: Number(paid.n),
    completed: player?.completed ?? 0,
    average: player?.rating_count ? Math.round((player.rating_sum / player.rating_count) * 100) / 100 : 0,
    ratingCount: player?.rating_count ?? 0,
    upcomingCount: upcoming.length,
    nextBookingAt: upcoming[0]?.start_at ?? null,
  };
}
