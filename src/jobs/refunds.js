import { getDb } from "../db.js";
import { markPaid, pendingRefunds } from "../domain/ledger.js";
import { getBooking } from "../domain/bookings.js";
import { PROVIDERS } from "../pay/gateway.js";
import { now } from "../discord/clock.js";
import { log } from "../log.js";

// Refunds that the gateway can send itself. payOS has no refund API, so those stay in the owner's queue; money that came in through
// Stripe goes back to the same card automatically, and the ledger row is marked paid (by "auto") once the gateway accepted it. Every call
// carries an idempotency key made from the ledger row and the order, so running the job again after a failure can never refund twice.

const paidOrders = (bookingId) =>
  getDb().prepare("SELECT * FROM orders WHERE booking_id = ? AND status = 'PAID' AND kind IN ('BOOKING','EXTEND') ORDER BY paid_at DESC, order_code DESC").all(bookingId);

// planRefund(row) -> [{ order, amount }] covering the whole row from refundable orders, or null when some of it cannot be sent back automatically
export function planRefund(row) {
  let remaining = row.amount_vnd;
  const plan = [];
  for (const order of paidOrders(row.booking_id)) {
    if (remaining <= 0) break;
    const provider = PROVIDERS[order.provider];
    if (!provider?.canRefund || !provider.enabled()) return null;
    const amount = Math.min(remaining, order.amount);
    plan.push({ order, amount });
    remaining -= amount;
  }
  return remaining === 0 && plan.length ? plan : null;
}

export async function runRefunds(client, t = now()) {
  let refunded = 0;
  for (const row of pendingRefunds()) {
    const plan = planRefund(row);
    if (!plan) continue;
    try {
      for (const { order, amount } of plan) await PROVIDERS[order.provider].refund(order, amount, `ledger-${row.id}-${order.order_code}`);
      const result = markPaid(row.id, "auto", `hoàn tự động qua ${PROVIDERS[plan[0].order.provider].name}`, t);
      if (!result.alreadyPaid) {
        refunded += 1;
        try {
          await client?.notifyBooking?.({ kind: "auto_refund", row, booking: getBooking(row.booking_id) });
        } catch (error) {
          log.error("refund.announce_failed", { ledger: row.id, error });
        }
      }
    } catch (error) {
      log.error("refund.failed", { ledger: row.id, error });
    }
  }
  return { refunded };
}

export default {
  name: "refunds",
  everyMs: 5 * 60_000,
  run: (client) => runRefunds(client),
};
