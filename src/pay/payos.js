import { createHmac, timingSafeEqual } from "node:crypto";
import { paymentKeys } from "./credentials.js";

const BASE = "https://api-merchant.payos.vn";

export class PayError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // off | api | bad
  }
}

const keys = () => paymentKeys().payos;

export const payosEnabled = () => Boolean(keys().clientId && keys().apiKey && keys().checksumKey);

// payOS signs a payment request over these five fields, sorted by name: HMAC-SHA256 with the channel's checksum key
export function signPaymentRequest({ amount, cancelUrl, description, orderCode, returnUrl }, checksumKey = keys().checksumKey) {
  const data = `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
  return createHmac("sha256", checksumKey).update(data).digest("hex");
}

// A webhook is signed over all the fields of its data object, sorted by name, written as key=value joined by &. null and undefined
// become empty text. Returns true only for a signature made with the channel's own checksum key.
export function verifyWebhookSignature(data, signature, checksumKey = keys().checksumKey) {
  if (!data || typeof data !== "object" || typeof signature !== "string" || !checksumKey) return false;
  const text = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k] === null || data[k] === undefined || data[k] === "null" || data[k] === "undefined" ? "" : typeof data[k] === "object" ? JSON.stringify(data[k]) : data[k]}`)
    .join("&");
  const expected = createHmac("sha256", checksumKey).update(text).digest("hex");
  const given = Buffer.from(signature.toLowerCase(), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function call(path, init = {}) {
  if (!payosEnabled()) throw new PayError("off", "payOS is not configured");
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-client-id": keys().clientId, "x-api-key": keys().apiKey, ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new PayError("api", `payOS request failed: ${error.message}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // an HTML error page from a gateway is handled below as a failed call
  }
  if (!response.ok || !body || body.code !== "00") {
    throw new PayError("api", `payOS answered ${response.status} ${body?.code ?? ""} ${body?.desc ?? ""}`.trim());
  }
  return body.data;
}

// Creates a payment link. The description may be at most 9 characters for accounts not linked through payOS, so callers keep it short.
// expiredAt (unix seconds, optional) closes the link at that moment, so money cannot arrive after the booking stopped waiting for it.
export async function createPaymentLink({ orderCode, amount, description, returnUrl, cancelUrl, expiredAt }) {
  const request = { orderCode, amount, description, cancelUrl, returnUrl };
  const data = await call("/v2/payment-requests", {
    method: "POST",
    body: JSON.stringify({ ...request, ...(expiredAt ? { expiredAt } : {}), signature: signPaymentRequest(request) }),
  });
  if (!data?.checkoutUrl) throw new PayError("bad", "payOS gave no checkout link");
  return { checkoutUrl: data.checkoutUrl, paymentLinkId: data.paymentLinkId };
}

// Looks an order up by its code. "paid" is true when payOS says PAID, or when the whole amount has arrived.
export async function getPayment(orderCode) {
  const data = await call(`/v2/payment-requests/${orderCode}`);
  const status = String(data.status ?? "").toUpperCase();
  const paid = status === "PAID" || (Number(data.amount) > 0 && Number(data.amountPaid) >= Number(data.amount));
  const closed = ["CANCELLED", "EXPIRED", "FAILED"].includes(status);
  // amount and amountPaid let the caller notice a partial payment on a link that then expires
  return { status, paid, closed, amount: Number(data.amount) || 0, amountPaid: Number(data.amountPaid) || 0 };
}

// Closes a link that is still open, so a customer who changed their mind cannot pay it afterwards. Best effort: false when payOS refuses.
export async function cancelPaymentLink(orderCode, reason = "Khach doi cach thanh toan") {
  try {
    await call(`/v2/payment-requests/${orderCode}/cancel`, { method: "POST", body: JSON.stringify({ cancellationReason: reason }) });
    return true;
  } catch {
    return false;
  }
}
