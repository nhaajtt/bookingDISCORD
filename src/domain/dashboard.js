import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { DAY, formatLocal, localParts, startOfLocalDay } from "./time.js";
import { summary as ledgerSummary } from "./ledger.js";
import { bonusGiven, walletLiability } from "./wallet.js";
import { topCustomers, topPlayers } from "./stats.js";
import { listPlayers } from "./players.js";

// The numbers behind the owner's dashboard. All of them are read from the same tables as everything else, for the last `days` local days.

const FINISHED = ["COMPLETED", "NO_SHOW_PLAYER", "NO_SHOW_CUSTOMER", "CANCELLED", "DISPUTED"];

// dashboardData(now, { days?, settings? }) -> { generatedAt, days, daily: [...], totals, statuses, ledger, wallet, players, topPlayers, topCustomers, orders }
export function dashboardData(now = Date.now(), { days = 30, settings = getSettings() } = {}) {
  const db = getDb();
  const zone = settings.timezone;
  const midnight = startOfLocalDay(now, zone);
  const since = midnight - (days - 1) * DAY;

  const daily = [];
  for (let i = 0; i < days; i += 1) {
    const from = since + i * DAY;
    const p = localParts(from + 12 * 60 * 60_000, zone);
    daily.push({ from, label: `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}`, bookings: 0, completed: 0, cancelled: 0, revenueVnd: 0, feeVnd: 0 });
  }
  const bucket = (ms) => daily[Math.min(days - 1, Math.max(0, Math.floor((ms - since) / DAY)))];

  for (const b of db.prepare("SELECT status, created_at, start_at FROM bookings WHERE start_at >= ? AND start_at < ?").all(since, midnight + DAY)) {
    const d = bucket(b.start_at);
    d.bookings += 1;
    if (b.status === "COMPLETED") d.completed += 1;
    if (b.status === "CANCELLED") d.cancelled += 1;
  }
  for (const r of db.prepare("SELECT kind, amount_vnd, created_at FROM ledger WHERE kind IN ('FEE_INCOME','PLAYER_PAYOUT') AND created_at >= ? AND created_at < ?").all(since, midnight + DAY)) {
    const d = bucket(r.created_at);
    d.revenueVnd += r.amount_vnd;
    if (r.kind === "FEE_INCOME") d.feeVnd += r.amount_vnd;
  }

  const statuses = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM bookings WHERE start_at >= ? GROUP BY status").all(since).map((r) => [r.status, r.n]));
  const finished = FINISHED.reduce((n, s) => n + (statuses[s] ?? 0), 0);
  const customers = db.prepare("SELECT COUNT(DISTINCT customer_id) AS n FROM bookings WHERE start_at >= ? AND status IN ('COMPLETED','IN_PROGRESS','CONFIRMED')").get(since).n;
  const returning = db
    .prepare("SELECT COUNT(*) AS n FROM (SELECT customer_id FROM bookings WHERE start_at >= ? AND status = 'COMPLETED' GROUP BY customer_id HAVING COUNT(*) >= 2)")
    .get(since).n;
  const rated = db.prepare("SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM bookings WHERE start_at >= ? AND rating IS NOT NULL").get(since);

  const orders = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM orders WHERE created_at >= ? GROUP BY status").all(since).map((r) => [r.status, r.n]));
  const players = listPlayers();
  const to = midnight + DAY;
  return {
    generatedAt: now,
    generatedText: formatLocal(now, zone),
    zone,
    days,
    daily,
    totals: {
      bookings: Object.values(statuses).reduce((a, b) => a + b, 0),
      completed: statuses.COMPLETED ?? 0,
      cancellationRate: finished ? Math.round(((statuses.CANCELLED ?? 0) / finished) * 1000) / 10 : null,
      disputeRate: finished ? Math.round(((statuses.DISPUTED ?? 0) / finished) * 1000) / 10 : null,
      revenueVnd: daily.reduce((n, d) => n + d.revenueVnd, 0),
      feeVnd: daily.reduce((n, d) => n + d.feeVnd, 0),
      customers,
      returningCustomers: returning,
      averageRating: rated.n ? Math.round(rated.avg * 100) / 100 : null,
      ratings: rated.n,
    },
    statuses,
    ledger: ledgerSummary(),
    wallet: { liabilityVnd: walletLiability().vnd, people: walletLiability().people, bonusGivenVnd: bonusGiven() },
    players: { active: players.filter((p) => p.status === "ACTIVE").length, paused: players.filter((p) => p.status === "PAUSED").length, pending: players.filter((p) => p.status === "PENDING").length, suspended: players.filter((p) => p.status === "SUSPENDED").length },
    topPlayers: topPlayers({ from: since, to, limit: 5 }).map((p) => ({ ...p, name: players.find((x) => x.userId === p.userId)?.displayName ?? p.userId })),
    topCustomers: topCustomers({ from: since, to, limit: 5 }),
    orders,
  };
}
