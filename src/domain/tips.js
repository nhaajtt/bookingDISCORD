import { getDb, transaction } from "../db.js";
import { fail } from "./errors.js";
import { DAY } from "./time.js";
import { walletBalance } from "./wallet.js";

// A tip is a thank-you from the customer to the player after a completed session, paid from the wallet. The whole amount goes to the
// player (the owner takes no fee on tips) as a TIP row in the ledger, owed like a payout but with no hold because the session is
// already over. One tip per booking, within a week of the end, never to yourself and never above a sane ceiling.

export const TIP_MIN_VND = 5_000;
export const TIP_MAX_VND = 2_000_000;
export const TIP_STEP_VND = 1_000;
export const TIP_WINDOW_MS = 7 * DAY;
export const TIP_CHOICES = [10_000, 20_000, 50_000, 100_000];

export function validateTip(amountVnd) {
  if (!Number.isInteger(amountVnd) || amountVnd % TIP_STEP_VND || amountVnd < TIP_MIN_VND || amountVnd > TIP_MAX_VND) {
    fail("INVALID_INPUT", { message: `Tip phải là bội số của ${TIP_STEP_VND.toLocaleString("vi-VN")} đ, từ ${TIP_MIN_VND.toLocaleString("vi-VN")} đến ${TIP_MAX_VND.toLocaleString("vi-VN")} đ.` });
  }
  return amountVnd;
}

export const tipFor = (bookingId) => getDb().prepare("SELECT * FROM ledger WHERE booking_id = ? AND kind = 'TIP'").get(bookingId) ?? null;

// tipPlayer(bookingId, customerId, amountVnd, now) -> { tip, balance }
export function tipPlayer(bookingId, customerId, amountVnd, now = Date.now()) {
  validateTip(amountVnd);
  return transaction(() => {
    const db = getDb();
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
    if (!booking) fail("NOT_FOUND", { what: "lịch" });
    if (booking.customer_id !== customerId) fail("FORBIDDEN_ACTOR");
    if (booking.status !== "COMPLETED") fail("INVALID_INPUT", { message: "Chỉ tip được sau khi buổi chơi đã kết thúc." });
    if (now > (booking.ended_at ?? booking.start_at + booking.duration_min * 60_000) + TIP_WINDOW_MS) fail("TOO_LATE");
    if (tipFor(bookingId)) fail("INVALID_INPUT", { message: "Bạn đã tip cho buổi này rồi." });
    const balance = walletBalance(customerId);
    if (balance < amountVnd) fail("WALLET_LOW", { balance });
    db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'SPEND', ?, ?)").run(customerId, -amountVnd, `tip lịch #${bookingId}`, now);
    db.prepare("INSERT INTO ledger (booking_id, kind, party_user_id, amount_vnd, status, created_at, note) VALUES (?, 'TIP', ?, ?, 'OWED', ?, 'tip')").run(bookingId, booking.player_id, amountVnd, now);
    return { tip: tipFor(bookingId), balance: balance - amountVnd };
  });
}

// What a player has been tipped, for the profile and the owner's numbers
export function tipTotals(playerId = null) {
  const sql = "SELECT COUNT(*) AS n, COALESCE(SUM(amount_vnd), 0) AS vnd FROM ledger WHERE kind = 'TIP'";
  const row = playerId ? getDb().prepare(`${sql} AND party_user_id = ?`).get(playerId) : getDb().prepare(sql).get();
  return { count: Number(row.n), vnd: Number(row.vnd) };
}
