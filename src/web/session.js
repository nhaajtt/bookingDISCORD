import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signed cookies for the public site. A token is base64url(JSON) + "." + base64url(HMAC-SHA256). The kind of token ("s" session,
// "o" oauth state) is part of what is signed, so one kind can never be replayed as the other. Nothing secret goes inside: a
// session holds the Discord user id and name, the oauth state holds a random string and where to send the person afterwards.

export const SESSION_COOKIE = "bk_session";
export const STATE_COOKIE = "bk_oauth";
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
export const STATE_TTL_MS = 10 * 60_000;

const mac = (secret, kind, body) => createHmac("sha256", secret).update(`${kind}.${body}`).digest();

export function signToken(secret, kind, payload, ttlMs, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, k: kind, exp: now + ttlMs })).toString("base64url");
  return `${body}.${mac(secret, kind, body).toString("base64url")}`;
}

// Returns the payload, or null for anything wrong: bad shape, bad signature, wrong kind, expired
export function verifyToken(secret, kind, token, now = Date.now()) {
  if (!secret || typeof token !== "string" || token.length > 2048) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const wanted = mac(secret, kind, body);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload?.k !== kind || !Number.isFinite(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export const newState = () => randomBytes(24).toString("base64url");

// Constant-time comparison of two strings of any length
export function sameText(a, b) {
  const x = createHmac("sha256", "cmp").update(String(a)).digest();
  const y = createHmac("sha256", "cmp").update(String(b)).digest();
  return timingSafeEqual(x, y);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (!(name in out)) out[name] = part.slice(at + 1).trim();
  }
  return out;
}

// HttpOnly always; SameSite=Lax so a cross-site POST never carries it; Secure when the site is served over https
export function cookie(name, value, { maxAgeMs, secure }) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`;
}
export const clearCookie = (name, secure) => cookie(name, "", { maxAgeMs: 0, secure });
