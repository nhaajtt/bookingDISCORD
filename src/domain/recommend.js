import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { isBlacklisted } from "./strikes.js";
import { searchPlayers } from "./search.js";

// Suggesting players to a customer from what they already did. A plain score, every point with its reason, no hidden model:
//   +25 per game they booked before that this player offers (up to 3 games), +20 a player they booked and rated 4 or more,
//   +6 per average star, +10 free right now, +8 verified by staff, +5 trusted by the numbers. Players already booked and rated low
//   (2 or less) by this customer are left out.

export function recommendFor(userId, now = Date.now(), { limit = 5 } = {}, settings = getSettings()) {
  const db = getDb();
  const past = db.prepare("SELECT player_id, game, rating FROM bookings WHERE customer_id = ? AND status = 'COMPLETED'").all(userId);
  const gameCount = new Map();
  for (const b of past) gameCount.set(b.game.toLowerCase(), (gameCount.get(b.game.toLowerCase()) ?? 0) + 1);
  const lowRated = new Set(past.filter((b) => b.rating !== null && b.rating <= 2).map((b) => b.player_id));
  const happyWith = new Set(past.filter((b) => b.rating !== null && b.rating >= 4).map((b) => b.player_id));
  const verified = new Set(db.prepare("SELECT user_id FROM players WHERE verified_at IS NOT NULL").all().map((r) => r.user_id));
  const favouriteGames = [...gameCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g);

  const pool = searchPlayers({ excludeUserId: userId, limit: 200 }, now, settings);
  const scored = [];
  for (const p of pool) {
    if (lowRated.has(p.userId) || isBlacklisted(p.userId)) continue;
    const reasons = [];
    let score = 0;
    const shared = p.games.filter((g) => favouriteGames.includes(g.toLowerCase()));
    if (shared.length) {
      score += 25 * shared.length;
      reasons.push(`chơi ${shared.join(", ")} như bạn từng đặt`);
    }
    if (happyWith.has(p.userId)) {
      score += 20;
      reasons.push("bạn đã chấm cao ở lần trước");
    }
    if (p.ratingCount > 0) {
      score += Math.round(p.average * 6);
      reasons.push(`${p.average} sao (${p.ratingCount} lượt)`);
    }
    if (p.freeNow) {
      score += 10;
      reasons.push("đang rảnh");
    }
    if (verified.has(p.userId)) {
      score += 8;
      reasons.push("đã xác minh");
    }
    scored.push({ ...p, score, reasons });
  }
  scored.sort((a, b) => b.score - a.score || b.average - a.average || b.completed - a.completed);
  return scored.slice(0, limit);
}
