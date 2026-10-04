import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { DAY } from "./time.js";
import { walletBalance } from "./wallet.js";

// Paid membership. A plan (set by the owner in the settings) costs its price from the wallet and gives a percent off every booking for
// its length. The discount is paid out of the owner's fee, like a coupon, so a player is never paid less because of it. Buying again
// while a membership runs extends it from its end, so nobody loses days by renewing early.

const row = (r) =>
  r && { id: r.id, userId: r.user_id, planId: r.plan_id, planName: r.plan_name, discountPercent: r.discount_percent, priceVnd: r.price_vnd, startedAt: r.started_at, expiresAt: r.expires_at };

// The membership that is running at `now` (the best discount when several overlap), or null
export function activeMembership(userId, now = Date.now()) {
  return row(getDb().prepare("SELECT * FROM memberships WHERE user_id = ? AND started_at <= ? AND expires_at > ? ORDER BY discount_percent DESC, expires_at DESC LIMIT 1").get(userId, now, now)) ?? null;
}

export const membershipHistory = (userId, limit = 10) => getDb().prepare("SELECT * FROM memberships WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit).map(row);

export function planFor(planId, settings = getSettings()) {
  const plan = settings.memberships.find((p) => p.id === planId);
  if (!plan) fail("INVALID_INPUT", { message: "Gói thành viên này không còn nữa." });
  return plan;
}

// buyMembership(userId, planId, now, settings) -> { membership, balance }
// The price comes out of the wallet in the same transaction that writes the membership, so it can never be one without the other.
export function buyMembership(userId, planId, now = Date.now(), settings = getSettings()) {
  return transaction(() => {
    const plan = planFor(planId, settings);
    const balance = walletBalance(userId);
    if (balance < plan.priceVnd) fail("WALLET_LOW", { balance });
    const db = getDb();
    const running = db.prepare("SELECT MAX(expires_at) AS e FROM memberships WHERE user_id = ? AND plan_id = ? AND expires_at > ?").get(userId, plan.id, now)?.e;
    const startedAt = running ?? now;
    db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'SPEND', ?, ?)").run(userId, -plan.priceVnd, `thành viên ${plan.name}`, now);
    const info = db.prepare("INSERT INTO memberships (user_id, plan_id, plan_name, discount_percent, price_vnd, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(userId, plan.id, plan.name, plan.discountPercent, plan.priceVnd, startedAt, startedAt + plan.days * DAY);
    return { membership: row(db.prepare("SELECT * FROM memberships WHERE id = ?").get(Number(info.lastInsertRowid))), balance: balance - plan.priceVnd };
  });
}

// What memberships brought in and how many are running (the owner's numbers)
export function membershipReport(now = Date.now()) {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_vnd), 0) AS vnd FROM memberships").get();
  const active = db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM memberships WHERE started_at <= ? AND expires_at > ?").get(now, now);
  return { soldCount: Number(total.n), soldVnd: Number(total.vnd), activeMembers: Number(active.n) };
}
