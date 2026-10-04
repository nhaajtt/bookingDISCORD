import { getSettings } from "../settings.js";
import { PayError } from "./payos.js";
import { PROVIDERS, defaultProvider } from "./gateway.js";
import { paymentKeys } from "./credentials.js";
import { closeOrder, createBookingOrder, createExtendOrder, createTopupOrder, pendingOrderFor, setCheckoutUrl } from "./orders.js";

// Makes an order and its payment link in one step, for the three things a customer can pay for. If the gateway refuses, the order is
// closed as FAILED and the error goes to the caller, so no order is left waiting for a link that does not exist.

function chosen(provider) {
  const name = provider ?? defaultProvider();
  if (!name || !PROVIDERS[name]?.enabled()) throw new PayError("off", "No payment gateway is configured");
  return name;
}

async function link(provider, order) {
  const { returnUrl } = paymentKeys();
  try {
    const made = await PROVIDERS[provider].createLink({ orderCode: order.orderCode, amount: order.amount, description: order.description, returnUrl, cancelUrl: returnUrl, expiredAt: order.expiredAt });
    setCheckoutUrl(order.orderCode, made.checkoutUrl, made.externalId);
    return made.checkoutUrl;
  } catch (error) {
    closeOrder(order.orderCode, "FAILED");
    throw error;
  }
}

// An order for a booking that waits for payment. A link that is already open is returned again instead of making a second one.
export async function checkoutBooking(booking, now = Date.now(), provider = null, settings = getSettings()) {
  const existing = pendingOrderFor(booking.id);
  if (existing?.checkout_url) return { orderCode: existing.order_code, checkoutUrl: existing.checkout_url, provider: existing.provider, reused: true };
  const name = chosen(provider);
  const order = createBookingOrder(booking.id, now, Math.random, settings, name);
  return { orderCode: order.orderCode, checkoutUrl: await link(name, order), provider: name, reused: false };
}

export async function checkoutTopup(userId, amountVnd, bonusVnd, now = Date.now(), provider = null) {
  const name = chosen(provider);
  const order = createTopupOrder(userId, amountVnd, bonusVnd, now, Math.random, name);
  return { orderCode: order.orderCode, checkoutUrl: await link(name, order), provider: name };
}

export async function checkoutExtension(booking, extraMin, amountVnd, feeVnd, now = Date.now(), provider = null) {
  const name = chosen(provider);
  const order = createExtendOrder(booking.id, extraMin, amountVnd, feeVnd, now, Math.random, name);
  return { orderCode: order.orderCode, checkoutUrl: await link(name, order), provider: name };
}
