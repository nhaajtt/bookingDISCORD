import { transaction } from "../db.js";
import { PROVIDERS, anyProviderEnabled } from "../pay/gateway.js";
import { closeOrder, expireStaleOrders, getOrder, pendingOrders, settleOrder } from "../pay/orders.js";
import { getBooking, pay } from "../domain/bookings.js";
import { applyExtension } from "../domain/extensions.js";
import { creditTopup, walletBalance } from "../domain/wallet.js";
import { log } from "../log.js";

// There is no public address for a gateway to call unless the web server is on, so the bot asks about its own open orders instead
// (the payOS webhook, when enabled, only makes this run sooner). That keeps every secret on this machine.
//
// The order flip and what the payment buys happen in one transaction: if confirming fails, the flip is undone and the order is tried
// again on the next round, so money is never marked as received without the booking, the wallet or the session knowing.
//
// The Discord layer may set client.notifyBooking(event) to be told about results, where event is
//   { kind: "paid", booking, order }          the booking is now CONFIRMED
//   { kind: "late_refund", booking, order }   the money arrived after the booking expired or was cancelled; a REFUND row is owed
//   { kind: "partial", booking, order, amountPaid }   the link closed with only part of the amount paid; the owner settles it by hand
//   { kind: "topup", order, balance }         the wallet was credited
//   { kind: "extended", booking, order }      the session was made longer
//   { kind: "extend_failed", booking, order } the extension was paid but the session could not take it; the owner refunds by hand
//   { kind: "duplicate", booking, order }     a second payment for a booking that was already paid; the owner refunds it by hand

async function notify(client, event, order) {
  try {
    await client?.notifyBooking?.(event);
  } catch (error) {
    log.error("payment.announce_failed", { order: order.order_code, error });
  }
}

// What one confirmed payment buys, by the kind of the order. Runs inside the transaction that flips the order.
function fulfil(order, now) {
  if (order.kind === "TOPUP") {
    creditTopup(order.order_code, order.user_id, order.amount, order.bonus_vnd, now);
    return { event: { kind: "topup", order, balance: walletBalance(order.user_id) } };
  }
  if (order.kind === "EXTEND") {
    try {
      const booking = applyExtension(order.booking_id, order.extra_min, order.amount, order.extra_fee, now);
      return { event: { kind: "extended", booking, order } };
    } catch (error) {
      if (error.code !== "NOT_EXTENDABLE") throw error;
      return { event: { kind: "extend_failed", booking: getBooking(order.booking_id), order } };
    }
  }
  try {
    const outcome = pay(order.booking_id, now, order.amount);
    return { late: outcome.late, event: { kind: outcome.late ? "late_refund" : "paid", booking: outcome.booking, order } };
  } catch (error) {
    const booking = getBooking(order.booking_id);
    if (error.code === "ILLEGAL_TRANSITION" && booking?.paid_at) return { event: { kind: "duplicate", booking, order } };
    throw error;
  }
}

// checkPayments(client, now, { only? }) -> { checked, paid, late }. `only` limits the round to one order code (the webhook uses it).
export async function checkPayments(client, now = Date.now(), { only = null } = {}) {
  if (!anyProviderEnabled()) return { checked: 0, paid: 0, late: 0 };
  let paid = 0;
  let late = 0;
  const orders = pendingOrders(now).filter((o) => only === null || o.order_code === only);
  for (const order of orders) {
    try {
      const provider = PROVIDERS[order.provider];
      if (!provider?.enabled()) continue;
      const payment = await provider.getPayment(order);
      if (payment.paid) {
        const result = transaction(() => {
          const settled = settleOrder(order.order_code, now);
          if (!settled) return null;
          return fulfil(settled, now);
        });
        if (result) {
          if (result.late) late += 1;
          else paid += 1;
          await notify(client, result.event, order);
        }
      } else if (payment.closed) {
        closeOrder(order.order_code, payment.status);
        // A link that closed after part of the money arrived is a manual exception for the owner, never silently dropped
        if (payment.amountPaid > 0) await notify(client, { kind: "partial", booking: getBooking(order.booking_id), order, amountPaid: payment.amountPaid }, order);
      }
    } catch (error) {
      // One order that cannot be read or confirmed right now must not stop the others; it is tried again on the next round
      log.error("payment.check_failed", { order: order.order_code, error });
    }
  }
  expireStaleOrders(now);
  return { checked: orders.length, paid, late };
}

// Looks at one order straight away (used by the webhook): the answer comes from the gateway, never from the webhook body
export const checkOrder = (client, orderCode, now = Date.now()) => (getOrder(orderCode) ? checkPayments(client, now, { only: orderCode }) : { checked: 0, paid: 0, late: 0 });

export default {
  name: "payments",
  everyMs: 30_000,
  run: (client) => checkPayments(client),
};
