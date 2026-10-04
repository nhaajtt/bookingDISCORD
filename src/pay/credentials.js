import { config } from "../config.js";
import { currentTenant } from "../db.js";
import { kvGet, kvSet } from "../kv.js";

// Where the payment keys of the server in front of us come from. A single-server install reads the environment. In multi-server mode
// every server brings its own keys, kept in that server's own database (never in the shared environment), set by its owner.

const empty = { payos: { clientId: null, apiKey: null, checksumKey: null }, stripe: { secretKey: null, webhookSecret: null }, returnUrl: null };

function stored() {
  try {
    return JSON.parse(kvGet("payment_keys") ?? "{}");
  } catch {
    return {};
  }
}

export function paymentKeys() {
  if (!currentTenant()) return { payos: config.payos, stripe: config.stripe, returnUrl: config.returnUrl, provider: config.paymentProvider };
  const s = stored();
  return { payos: { ...empty.payos, ...s.payos }, stripe: { ...empty.stripe, ...s.stripe }, returnUrl: s.returnUrl ?? config.returnUrl, provider: s.provider ?? null };
}

// Saves the keys of the current server (multi-server mode). Pass only what changes; null removes a key.
export function savePaymentKeys(patch) {
  const s = stored();
  const next = { ...s, ...patch, payos: { ...s.payos, ...patch.payos }, stripe: { ...s.stripe, ...patch.stripe } };
  kvSet("payment_keys", JSON.stringify(next));
  return next;
}
