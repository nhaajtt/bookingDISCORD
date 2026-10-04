import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { kvGet, kvSet } from "../kv.js";

// Access to the dashboard: a secret token, either the DASHBOARD_TOKEN of the environment or one the owner makes with /admin
// bang-dieu-khien (stored in that server's own database, and replaceable). Tokens are compared as hashes in constant time.

const digest = (text) => createHash("sha256").update(String(text)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

export function dashboardToken({ rotate = false } = {}) {
  let token = kvGet("dashboard_token");
  if (!token || rotate) {
    token = randomBytes(24).toString("base64url");
    kvSet("dashboard_token", token);
  }
  return token;
}

export function tokenValid(given) {
  if (typeof given !== "string" || given.length < 8) return false;
  const stored = kvGet("dashboard_token");
  return Boolean((config.web.dashboardToken && same(given, config.web.dashboardToken)) || (stored && same(given, stored)));
}

// How many wrong tokens one address may try per minute before it is told to wait
const failures = new Map();
export function tooManyFailures(address, now = Date.now()) {
  const recent = (failures.get(address) ?? []).filter((t) => now - t < 60_000);
  failures.set(address, recent);
  return recent.length >= 8;
}
export function recordFailure(address, now = Date.now()) {
  failures.set(address, [...(failures.get(address) ?? []), now]);
  if (failures.size > 2000) for (const [k, v] of failures) if (!v.some((t) => now - t < 60_000)) failures.delete(k);
}
export const resetFailures = () => failures.clear();

export function metricsAllowed(request) {
  const wanted = config.web.metricsToken;
  if (wanted) return same(String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), wanted);
  // Behind a reverse proxy every request comes from localhost, so a forwarded request must carry the token
  if (request.headers["x-forwarded-for"] || request.headers.forwarded) return false;
  const address = request.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
