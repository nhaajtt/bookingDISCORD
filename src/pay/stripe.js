import { paymentKeys } from "./credentials.js";
import { PayError } from "./payos.js";

// Stripe Checkout as a second payment gateway, through plain fetch (no SDK). VND is a zero-decimal currency in Stripe, so the amount in
// dong is sent as it is. Unlike payOS, Stripe can send money back, which is what lets refunds be automatic for these orders.

const BASE = "https://api.stripe.com";
// Stripe does not accept a session that lives less than 30 minutes, so the link outlives the booking's payment window slightly; a
// payment that lands after the booking expired is refunded by the normal late-payment path.
export const MIN_SESSION_MIN = 31;

const key = () => paymentKeys().stripe.secretKey;
export const stripeEnabled = () => Boolean(key());

// Stripe takes form-encoded bodies with bracket names: { a: { b: 1 } } -> a[b]=1
export function formEncode(value, prefix = "", out = []) {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) formEncode(v, prefix ? `${prefix}[${k}]` : k, out);
  } else if (value !== undefined && value !== null) {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

async function call(path, { method = "GET", body = null, idempotencyKey = null } = {}) {
  if (!stripeEnabled()) throw new PayError("off", "Stripe is not configured");
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${key()}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: body ? formEncode(body).join("&") : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new PayError("api", `Stripe request failed: ${error.message}`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // handled below
  }
  if (!response.ok || !data || data.error) throw new PayError("api", `Stripe answered ${response.status} ${data?.error?.code ?? ""} ${data?.error?.message ?? ""}`.trim());
  return data;
}

export async function createCheckout({ orderCode, amount, description, returnUrl, cancelUrl, now = Date.now() }) {
  const session = await call("/v1/checkout/sessions", {
    method: "POST",
    idempotencyKey: `order-${orderCode}`,
    body: {
      mode: "payment",
      client_reference_id: String(orderCode),
      success_url: returnUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(now / 1000) + MIN_SESSION_MIN * 60,
      line_items: [{ quantity: 1, price_data: { currency: "vnd", unit_amount: amount, product_data: { name: description } } }],
    },
  });
  if (!session.url || !session.id) throw new PayError("bad", "Stripe gave no checkout link");
  return { checkoutUrl: session.url, externalId: session.id };
}

// The same shape as payOS getPayment: { status, paid, closed, amount, amountPaid }
export async function getCheckout(externalId) {
  const s = await call(`/v1/checkout/sessions/${encodeURIComponent(externalId)}`);
  const paid = s.payment_status === "paid";
  return { status: String(s.status ?? "").toUpperCase(), paid, closed: s.status === "expired", amount: Number(s.amount_total) || 0, amountPaid: paid ? Number(s.amount_total) || 0 : 0 };
}

// Closes a session that is still open
export async function expireCheckout(externalId) {
  try {
    await call(`/v1/checkout/sessions/${encodeURIComponent(externalId)}/expire`, { method: "POST" });
    return true;
  } catch {
    return false;
  }
}

// refundCheckout(externalId, amountVnd, key) sends money back to the card of that payment. The idempotency key makes a retry safe.
export async function refundCheckout(externalId, amountVnd, idempotencyKey) {
  const s = await call(`/v1/checkout/sessions/${encodeURIComponent(externalId)}`);
  if (!s.payment_intent) throw new PayError("bad", "Stripe session has no payment to refund");
  const refund = await call("/v1/refunds", { method: "POST", idempotencyKey, body: { payment_intent: s.payment_intent, amount: amountVnd } });
  return { id: refund.id, status: refund.status };
}
