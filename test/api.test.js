import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, confirmed, book, fresh, getDb, saveSettings } from "./helpers.js";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { createWebServer } from "../src/web/server.js";
import { SESSION_COOKIE, STATE_COOKIE, SESSION_TTL_MS, signToken, verifyToken, parseCookies } from "../src/web/session.js";
import { resetLimits } from "../src/discord/limits.js";
import { setLogSink } from "../src/log.js";
import { addToBlacklist } from "../src/domain/strikes.js";
import { adjustWallet, walletBalance } from "../src/domain/wallet.js";
import { createCoupon } from "../src/domain/coupons.js";
import { setBank } from "../src/domain/bank.js";
import { getBooking, start, complete, SYSTEM } from "../src/domain/bookings.js";
import { getPlayer, setMedia } from "../src/domain/players.js";
import { getAvailability } from "../src/domain/availability.js";
import { setGameRates } from "../src/domain/quoting.js";
import { quoteBooking } from "../src/domain/quoting.js";
import { resetFailures } from "../src/web/auth.js";

const realFetch = globalThis.fetch;
const SITE = "https://book.example.test";
const SECRET = "s".repeat(48);
const CUSTOMER = "200000000000000001";

let web;
let base;
let clock;
let events;
let discord;
let logs;

beforeEach(async () => {
  fresh();
  resetLimits();
  resetFailures();
  clock = NOW;
  events = [];
  logs = [];
  setLogSink((record) => logs.push(record));
  Object.assign(config.web, { discordClientSecret: "client-secret-value", sessionSecret: SECRET, siteUrl: SITE, discordInviteUrl: "https://discord.gg/example" });
  discord = { token: { ok: true, status: 200, body: { access_token: "access-token-value" } }, user: { ok: true, status: 200, body: { id: CUSTOMER, username: "minh", global_name: "Minh" } }, calls: [] };
  globalThis.fetch = (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1")) return realFetch(url, init);
    if (target.startsWith("https://discord.com/api/v10/")) {
      discord.calls.push({ url: target, init });
      const answer = target.endsWith("/oauth2/token") ? discord.token : discord.user;
      return Promise.resolve({ ok: answer.ok, status: answer.status, json: async () => answer.body });
    }
    // payOS
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ code: "00", data: { checkoutUrl: "https://pay.example.test/checkout/1", paymentLinkId: "pl-1", status: "PENDING", amount: 100_000, amountPaid: 0 } }) });
  };
  const client = { notifyBooking: async (event) => events.push(event) };
  web = createWebServer({ client, now: () => clock });
  base = `http://127.0.0.1:${await web.listen(0, "127.0.0.1")}`;
  makePlayer("p1");
  makeCustomer("c1");
});
afterEach(async () => {
  await web.close();
  globalThis.fetch = realFetch;
  setLogSink(null);
  Object.assign(config.web, { discordClientSecret: null, sessionSecret: null, siteUrl: null, discordInviteUrl: null, dashboardToken: null });
});
after(() => {
  globalThis.fetch = realFetch;
});

const session = (id, name = "Tester", at = NOW, ttl = SESSION_TTL_MS) => `${SESSION_COOKIE}=${signToken(SECRET, "s", { uid: id, name }, ttl, at)}`;

// call("POST", "/api/bookings", { as: "c1", body }) -> { status, body, headers }
async function call(method, path, { as = null, body, origin = SITE, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (as) h.cookie = session(as);
  if (method !== "GET" && origin) h.origin = origin;
  if (body !== undefined || raw !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: type.includes("json") && text ? JSON.parse(text) : null };
}
const code = (r) => r.body?.error?.code;
const startAt = NOW + 3 * HOUR;
const order = (extra = {}) => ({ playerId: "p1", game: "Liên Quân", startAt, durationMin: 60, ...extra });

// ---------------------------------------------------------------- switched off

test("without the web variables the API says 503 and the rest of the server keeps working", async () => {
  Object.assign(config.web, { discordClientSecret: null, sessionSecret: null, siteUrl: null });
  const login = await call("GET", "/api/auth/login");
  assert.equal(login.status, 503);
  assert.equal(code(login), "WEB_DISABLED");
  assert.match(login.body.error.message, /chưa được bật/);
  assert.equal((await call("GET", "/api/me")).status, 503);
  assert.equal((await call("POST", "/api/bookings", { body: order() })).status, 503);
  assert.equal((await call("GET", "/healthz")).status, 200);
  config.web.dashboardToken = "owner-token-123";
  assert.equal((await call("GET", "/api/stats?token=owner-token-123")).status, 200, "the owner's /api/stats is untouched");
  assert.equal((await call("GET", "/api/stats")).status, 401);
});

test("the config demands a long session secret and an origin", async () => {
  const { readConfig } = await import("../src/config.js");
  const base = { DISCORD_TOKEN: "t", CLIENT_ID: "1", GUILD_ID: "100000000000000002" };
  assert.ok(readConfig({ ...base, SESSION_SECRET: "short" }).problems.some((p) => /SESSION_SECRET/.test(p)));
  assert.ok(readConfig({ ...base, WEB_SITE_URL: "https://book.example.test/path" }).problems.some((p) => /WEB_SITE_URL/.test(p)));
  const ok = readConfig({ ...base, SESSION_SECRET: SECRET, WEB_SITE_URL: "https://book.example.test/", DISCORD_CLIENT_SECRET: "x" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.web.siteUrl, "https://book.example.test");
});

// ---------------------------------------------------------------- tokens

test("a signed token verifies, and a changed, expired, foreign or wrong-kind one does not", () => {
  const token = signToken(SECRET, "s", { uid: "1" }, 1000, NOW);
  assert.equal(verifyToken(SECRET, "s", token, NOW + 999).uid, "1");
  assert.equal(verifyToken(SECRET, "s", token, NOW + 1000), null, "expired");
  assert.equal(verifyToken("x".repeat(48), "s", token, NOW), null, "another secret");
  assert.equal(verifyToken(SECRET, "o", token, NOW), null, "an oauth state is not a session and the other way round");
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "2", k: "s", exp: NOW + 5000 })).toString("base64url");
  assert.equal(verifyToken(SECRET, "s", `${forged}.${mac}`, NOW), null, "payload swapped under an old signature");
  assert.equal(verifyToken(SECRET, "s", `${body}.${mac.slice(0, -2)}AA`, NOW), null);
  assert.equal(verifyToken(SECRET, "s", `${body}.${mac}.x`, NOW), null);
  assert.equal(verifyToken(SECRET, "s", "garbage", NOW), null);
  assert.equal(verifyToken(SECRET, "s", undefined, NOW), null);
  assert.equal(verifyToken("", "s", token, NOW), null);
  assert.deepEqual(parseCookies("a=1; bk_session=abc=def; b"), { a: "1", bk_session: "abc=def" });
});

test("a session lasts seven days and then the same cookie is refused", async () => {
  const cookie = (at) => ({ cookie: session("c1", "Tester", at) });
  assert.equal((await call("GET", "/api/me", { headers: cookie(NOW - 6 * DAY) })).status, 200);
  const old = await call("GET", "/api/me", { headers: cookie(NOW - 8 * DAY) });
  assert.equal(old.status, 401);
  assert.equal(code(old), "LOGIN_REQUIRED");
  assert.equal((await call("GET", "/api/me")).status, 401);
  assert.equal((await call("GET", "/api/me", { headers: { cookie: `${SESSION_COOKIE}=nonsense` } })).status, 401);
});

// ---------------------------------------------------------------- login

test("login sends the visitor to Discord with a random state kept in a signed HttpOnly cookie", async () => {
  const r = await call("GET", "/api/auth/login?next=/lich-cua-toi");
  assert.equal(r.status, 302);
  const target = new URL(r.headers.get("location"));
  assert.equal(target.origin + target.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(target.searchParams.get("client_id"), config.clientId);
  assert.equal(target.searchParams.get("scope"), "identify");
  assert.equal(target.searchParams.get("response_type"), "code");
  assert.equal(target.searchParams.get("redirect_uri"), `${SITE}/api/auth/callback`);
  const state = target.searchParams.get("state");
  assert.ok(state.length >= 30);
  const [set] = r.headers.getSetCookie();
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Secure/);
  assert.match(set, /Max-Age=600/);
  const saved = verifyToken(SECRET, "o", set.split(";")[0].split("=").slice(1).join("="), NOW);
  assert.equal(saved.s, state);
  assert.equal(saved.n, "/lich-cua-toi");
  // two visits never share a state
  const other = new URL((await call("GET", "/api/auth/login")).headers.get("location")).searchParams.get("state");
  assert.notEqual(other, state);
  // an address that is not a path on the site is dropped
  const evil = await call("GET", "/api/auth/login?next=//evil.example");
  const evilCookie = evil.headers.getSetCookie()[0].split(";")[0].split("=").slice(1).join("=");
  assert.equal(verifyToken(SECRET, "o", evilCookie, NOW).n, "/");
});

async function startLogin() {
  const r = await call("GET", "/api/auth/login?next=/lich-cua-toi");
  return { state: new URL(r.headers.get("location")).searchParams.get("state"), cookie: r.headers.getSetCookie()[0].split(";")[0] };
}

test("the callback checks the state, trades the code and sets the session cookie", async () => {
  const { state, cookie } = await startLogin();
  const r = await call("GET", `/api/auth/callback?code=abc123&state=${state}`, { headers: { cookie } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), `${SITE}/lich-cua-toi`);
  const cookies = r.headers.getSetCookie();
  const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.match(sessionCookie, /Secure/);
  assert.match(sessionCookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
  assert.match(cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`)), /Max-Age=0/, "the state cookie is spent");
  const payload = verifyToken(SECRET, "s", sessionCookie.split(";")[0].split("=").slice(1).join("="), NOW);
  assert.deepEqual({ uid: payload.uid, name: payload.name }, { uid: CUSTOMER, name: "Minh" });
  assert.deepEqual(Object.keys(payload).sort(), ["exp", "k", "name", "uid"], "only the id and the name");
  const tokenCall = discord.calls[0];
  assert.match(String(tokenCall.init.body), /code=abc123/);
  assert.match(String(tokenCall.init.body), /grant_type=authorization_code/);
  assert.ok(!JSON.stringify(logs).includes("access-token-value") && !JSON.stringify(logs).includes("client-secret-value"), "no token in the logs");
  // and the cookie works
  const who = await call("GET", "/api/me", { headers: { cookie: sessionCookie.split(";")[0] } });
  assert.equal(who.body.user.id, CUSTOMER);
});

test("the callback refuses a wrong, missing or foreign state and a failed exchange", async () => {
  const { state, cookie } = await startLogin();
  const failed = (r) => {
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), `${SITE}/?login=failed`);
    assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/Max-Age=0/.test(c)), "no session");
  };
  failed(await call("GET", `/api/auth/callback?code=abc&state=${state}x`, { headers: { cookie } }));
  failed(await call("GET", `/api/auth/callback?code=abc&state=${state}`));
  failed(await call("GET", `/api/auth/callback?state=${state}`, { headers: { cookie } }));
  failed(await call("GET", `/api/auth/callback?code=abc`, { headers: { cookie } }));
  assert.equal(discord.calls.length, 0, "Discord is not even asked");
  // a state cookie that has gone stale
  clock = NOW + 11 * MIN;
  failed(await call("GET", `/api/auth/callback?code=abc&state=${state}`, { headers: { cookie } }));
  clock = NOW;
  // Discord refuses the code
  discord.token = { ok: false, status: 400, body: { error: "invalid_grant" } };
  failed(await call("GET", `/api/auth/callback?code=abc&state=${state}`, { headers: { cookie } }));
  assert.ok(logs.some((l) => l.event === "web.login_failed"));
  // the person pressed cancel on Discord
  const cancelled = await call("GET", `/api/auth/callback?error=access_denied&state=${state}`, { headers: { cookie } });
  assert.equal(cancelled.headers.get("location"), `${SITE}/?login=cancelled`);
  // a session cookie is not a state cookie
  failed(await call("GET", `/api/auth/callback?code=abc&state=${state}`, { headers: { cookie: `${STATE_COOKIE}=${session("c1").split("=")[1]}` } }));
});

test("logout clears the cookie and needs the site's Origin like any write", async () => {
  assert.equal((await call("POST", "/api/auth/logout", { origin: null })).status, 403);
  const r = await call("POST", "/api/auth/logout", { as: "c1" });
  assert.equal(r.status, 200);
  assert.match(r.headers.getSetCookie()[0], /bk_session=; .*Max-Age=0/);
});

// ---------------------------------------------------------------- request hygiene

test("every write must come from the site: Origin or Referer equal to WEB_SITE_URL", async () => {
  const payload = { body: { stars: 5 }, as: "c1" };
  for (const origin of [null, "https://evil.example", "null", `${SITE}.evil.example`, "http://book.example.test"]) {
    const r = await call("POST", "/api/bookings/1/rate", { ...payload, origin });
    assert.equal(r.status, 403, String(origin));
    assert.equal(code(r), "BAD_ORIGIN");
  }
  // a Referer from the site is enough when the browser sends no Origin
  const viaReferer = await call("POST", "/api/bookings/1/rate", { ...payload, origin: null, headers: { referer: `${SITE}/lich-cua-toi` } });
  assert.notEqual(code(viaReferer), "BAD_ORIGIN");
  const badReferer = await call("POST", "/api/bookings/1/rate", { ...payload, origin: null, headers: { referer: "https://evil.example/x" } });
  assert.equal(code(badReferer), "BAD_ORIGIN");
  // reads do not need it, and no CORS header is ever sent
  const read = await call("GET", "/api/players", { headers: { origin: "https://evil.example" } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("access-control-allow-origin"), null);
  assert.equal((await call("OPTIONS", "/api/players")).status, 405);
});

test("bodies are small JSON objects, errors never carry a stack, and unknown paths are plain JSON 404s", async () => {
  assert.equal((await call("POST", "/api/quote", { raw: "x".repeat(20_000) })).status, 413);
  const bad = await call("POST", "/api/quote", { raw: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal(code(bad), "BAD_JSON");
  assert.equal(code(await call("POST", "/api/quote", { raw: "[1,2]" })), "BAD_JSON");
  const wrongType = await fetch(`${base}/api/quote`, { method: "POST", headers: { origin: SITE, "content-type": "text/plain" }, body: "{}" });
  assert.equal(wrongType.status, 415);
  const missing = await call("GET", "/api/nothing");
  assert.equal(missing.status, 404);
  assert.deepEqual(Object.keys(missing.body), ["error"]);
  assert.ok(!missing.text.includes(" at "), "no stack");
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal(missing.headers.get("x-content-type-options"), "nosniff");
});

test("one address cannot hammer the API, and one person cannot spam bookings", async () => {
  let limited = null;
  for (let i = 0; i < 260 && !limited; i += 1) {
    const r = await call("GET", "/api/config");
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "the per-address limit kicks in");
  assert.equal(code(limited), "RATE_LIMITED");
  assert.equal(limited.headers.get("retry-after"), "30");
  resetLimits();
  makeCustomer(CUSTOMER);
  let refused = null;
  for (let i = 0; i < 8 && !refused; i += 1) {
    const r = await call("POST", "/api/bookings", { as: CUSTOMER, body: order({ startAt: startAt + (i + 5) * DAY, game: "Không có game này" }) });
    if (r.status === 429) refused = r;
  }
  assert.ok(refused, "the per-person booking bucket kicks in");
  assert.match(refused.body.error.message, /đặt lịch quá nhiều/);
});

// ---------------------------------------------------------------- reading players

test("the player list shows active players only and only the public fields", async () => {
  makePlayer("p2", { status: "PAUSED" });
  makePlayer("p3", { status: "PENDING" });
  setBank("p1", { bank: "Vietcombank", accountNo: "9704123456789", accountName: "NGUYEN VAN A" });
  setMedia("p1", { photos: ["https://img.example.test/a.jpg"] });
  setGameRates("p1", { "Liên Quân": 150_000 });
  const r = await call("GET", "/api/players");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.players.map((p) => p.id), ["p1"]);
  const [p] = r.body.players;
  assert.deepEqual(Object.keys(p).sort(), ["badges", "bio", "completed", "freeNow", "games", "hours", "id", "languages", "name", "nextFreeAt", "photos", "rateVnd", "rating", "voiceUrl"]);
  assert.deepEqual(p.games, [{ name: "Liên Quân", rateVnd: 150_000 }, { name: "LoL", rateVnd: 100_000 }]);
  assert.deepEqual(p.photos, ["https://img.example.test/a.jpg"]);
  assert.equal(p.name, "Player p1");
  assert.equal(p.freeNow, true);
  // nothing private anywhere in the text of the answer
  for (const secret of ["9704123456789", "NGUYEN", "Vietcombank", "status", "user_id", "approved", "profile_message", "left_at", "ratingSum"]) assert.ok(!r.text.includes(secret), `${secret} leaked`);
});

test("the list filters by game and by words, and ?free=1 keeps who is free now", async () => {
  makePlayer("p2", { games: ["Valorant", "Trò chuyện"], availability: "T3 00:00-24:00" });
  const names = async (query) => (await call("GET", `/api/players${query}`)).body.players.map((p) => p.id).sort();
  assert.deepEqual(await names(""), ["p1", "p2"]);
  assert.deepEqual(await names("?game=Valorant"), ["p2"]);
  assert.deepEqual(await names("?game=valorant"), ["p2"]);
  assert.deepEqual(await names("?game=Liên%20Quân"), ["p1"]);
  assert.deepEqual(await names("?q=trò"), ["p2"]);
  assert.deepEqual(await names("?q=player%20p1"), ["p1"]);
  assert.deepEqual(await names("?q=zzz"), []);
  assert.deepEqual(await names("?free=1"), ["p1"], "p2 only works on Tuesdays and today is Monday");
  assert.deepEqual(await names("?sort=nonsense"), ["p1", "p2"]);
});

test("config tells the site what it needs and who is looking", async () => {
  const anonymous = await call("GET", "/api/config");
  assert.equal(anonymous.body.loginEnabled, true);
  assert.equal(anonymous.body.viewer, null);
  assert.equal(anonymous.body.stepMin, 30);
  assert.equal(anonymous.body.timezone, "Asia/Ho_Chi_Minh");
  assert.deepEqual(anonymous.body.games.map((g) => g.name).sort(), ["Liên Quân", "LoL"]);
  assert.equal(anonymous.body.discord.inviteUrl, "https://discord.gg/example");
  const known = await call("GET", "/api/config", { as: "c1" });
  assert.deepEqual(known.body.viewer, { id: "c1", name: "Tester" });
  assert.ok(!anonymous.text.includes(SECRET) && !anonymous.text.includes("client-secret-value"));
});

test("a profile has free slots for 14 days: 30-minute steps, lead time, weekly hours and bookings respected", async () => {
  makePlayer("p4", { availability: "T2 11:00-13:00; T3 20:00-21:00" });
  const r = await call("GET", "/api/players/p4");
  assert.equal(r.status, 200);
  assert.equal(r.body.days.length, 14);
  assert.equal(r.body.days[0].date, "2026-10-05");
  const time = (ms) => new Date(ms + 7 * HOUR).toISOString().slice(11, 16);
  // Monday 10:00 now, one hour of lead time: 11:00 is the first start and 12:30 the last
  assert.deepEqual(r.body.days[0].starts.map(time), ["11:00", "11:30", "12:00", "12:30"]);
  assert.deepEqual(r.body.days[1].starts.map(time), ["20:00", "20:30"]);
  assert.deepEqual(r.body.days[2].starts, []);
  assert.deepEqual(r.body.days[7].starts.map(time), ["11:00", "11:30", "12:00", "12:30"], "next Monday");
  for (const day of r.body.days) for (const at of day.starts) assert.equal(at % (30 * MIN), 0);

  // a paid booking and an unpaid one inside its payment window both take their slots away
  confirmed({ customerId: "c1", playerId: "p4", game: "Liên Quân", startAt: NOW + 2 * HOUR, durationMin: 60 });
  const again = await call("GET", "/api/players/p4");
  assert.deepEqual(again.body.days[0].starts.map(time), ["11:00", "11:30"]);
  makeCustomer("c2");
  book({ customerId: "c2", playerId: "p4", startAt: NOW + 34 * HOUR, durationMin: 30 });
  assert.deepEqual((await call("GET", "/api/players/p4")).body.days[1].starts.map(time), ["20:30"]);
  // after the payment window it is free again
  clock = NOW + 31 * MIN + 1;
  assert.ok((await call("GET", "/api/players/p4")).body.days[1].starts.map(time).includes("20:00"));
});

test("slots stop at the booking horizon, and an unknown, paused or pending player has no profile", async () => {
  saveSettings({ maxAdvanceDays: 3 });
  const days = (await call("GET", "/api/players/p1")).body.days;
  assert.ok(days[3].starts.length > 0 && days[3].starts.every((at) => at <= NOW + 3 * DAY));
  assert.deepEqual(days[4].starts, []);
  makePlayer("p5", { status: "PAUSED" });
  makePlayer("p6", { status: "PENDING" });
  for (const id of ["p5", "p6", "ghost", "c1"]) {
    const r = await call("GET", `/api/players/${id}`);
    assert.equal(r.status, 404, id);
    assert.equal(code(r), "NOT_FOUND");
  }
  assert.equal((await call("GET", "/api/players/bad%20id")).status, 404);
});

// ---------------------------------------------------------------- quotes

test("a quote is exactly what the booking code would charge", async () => {
  saveSettings({ peaks: [{ days: [1], startMin: 600, endMin: 1440, percent: 20 }] });
  setGameRates("p1", { "Liên Quân": 120_000 });
  const r = await call("POST", "/api/quote", { body: order({ game: "liên quân", durationMin: 90 }) });
  assert.equal(r.status, 200);
  const expected = quoteBooking({ player: getPlayer("p1"), game: "Liên Quân", startAt, durationMin: 90, now: NOW });
  assert.equal(r.body.priceVnd, expected.priceVnd);
  assert.equal(r.body.feeVnd, expected.feeVnd);
  assert.equal(r.body.listPriceVnd, expected.listPriceVnd);
  assert.equal(r.body.surchargeVnd, expected.surchargeVnd);
  assert.ok(r.body.surchargeVnd > 0);
  assert.equal(r.body.game, "Liên Quân");
  assert.equal(r.body.available, true);
  assert.equal(r.body.couponCode, null);
  // a taken slot is reported, not hidden
  confirmed({ customerId: "c1", startAt, durationMin: 60 });
  assert.equal((await call("POST", "/api/quote", { body: order() })).body.available, false);
});

test("a quote with a code needs a login and takes the discount out of the fee", async () => {
  createCoupon({ code: "XINCHAO", kind: "FIXED", value: 5000, perUser: 1 }, NOW);
  const anonymous = await call("POST", "/api/quote", { body: order({ coupon: "xinchao" }) });
  assert.equal(anonymous.status, 401);
  assert.equal(code(anonymous), "LOGIN_REQUIRED");
  const r = await call("POST", "/api/quote", { as: "c1", body: order({ coupon: " xinchao " }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.discountVnd, 5000);
  assert.equal(r.body.priceVnd, 95_000);
  assert.equal(r.body.couponCode, "XINCHAO");
  assert.equal(code(await call("POST", "/api/quote", { as: "c1", body: order({ coupon: "KHONGCO" }) })), "COUPON_INVALID");
});

test("a quote refuses what cannot be sold", async () => {
  assert.equal(code(await call("POST", "/api/quote", { body: order({ game: "Cờ tỷ phú" }) })), "GAME_NOT_OFFERED");
  assert.equal(code(await call("POST", "/api/quote", { body: order({ durationMin: 45 }) })), "BAD_DURATION");
  assert.equal(code(await call("POST", "/api/quote", { body: order({ durationMin: 24 * 60 }) })), "BAD_DURATION");
  assert.equal(code(await call("POST", "/api/quote", { body: order({ playerId: "ghost" }) })), "PLAYER_NOT_ACTIVE");
  assert.equal(code(await call("POST", "/api/quote", { body: order({ startAt: "tomorrow" }) })), "INVALID_INPUT");
  assert.equal(code(await call("POST", "/api/quote", { body: { playerId: "p1" } })), "INVALID_INPUT");
  makePlayer("p7", { status: "PAUSED" });
  assert.equal(code(await call("POST", "/api/quote", { body: order({ playerId: "p7" }) })), "PLAYER_NOT_ACTIVE");
});

// ---------------------------------------------------------------- me

test("/api/me needs a login and shows only my own things", async () => {
  assert.equal((await call("GET", "/api/me")).status, 401);
  makeCustomer("c2");
  const mine = book({ customerId: "c1", startAt });
  book({ customerId: "c2", startAt: startAt + 5 * HOUR });
  adjustWallet("c1", 250_000, "thử", NOW);
  const r = await call("GET", "/api/me", { as: "c1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.attested, true);
  assert.equal(r.body.wallet.balanceVnd, 250_000);
  assert.deepEqual(r.body.bookings.map((b) => b.id), [mine.id]);
  const [b] = r.body.bookings;
  assert.equal(b.status, "AWAITING_PAYMENT");
  assert.equal(b.expiresAt, mine.created_at + 30 * MIN);
  assert.equal(b.canCancel, true);
  assert.deepEqual(b.player, { id: "p1", name: "Player p1" });
  assert.equal(r.body.player, null);
  assert.ok(!r.text.includes("c2") && !r.text.includes("customer_id"));
  // a newcomer has not confirmed 18+
  const fresh2 = await call("GET", "/api/me", { as: "newcomer" });
  assert.equal(fresh2.body.attested, false);
  assert.deepEqual(fresh2.body.bookings, []);
});

// ---------------------------------------------------------------- booking

test("a booking from the site goes through the same rules and is created awaiting payment", async () => {
  const r = await call("POST", "/api/bookings", { as: "c1", body: order() });
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.status, "AWAITING_PAYMENT");
  assert.equal(r.body.booking.priceVnd, 100_000);
  assert.equal(r.body.payment.canPayWithWallet, false);
  assert.equal(r.body.payment.canPayByLink, true);
  assert.equal(r.body.payment.checkoutUrl, null);
  const row = getBooking(r.body.booking.id);
  assert.equal(row.customer_id, "c1");
  assert.equal(row.status, "AWAITING_PAYMENT");
  assert.equal(events.length, 0, "nothing is announced before it is paid");
});

test("paying from the wallet in the same call confirms the booking and announces it like the Discord flow", async () => {
  adjustWallet("c1", 300_000, "nạp thử", NOW);
  const r = await call("POST", "/api/bookings", { as: "c1", body: order({ payWith: "wallet" }) });
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.status, "CONFIRMED");
  assert.equal(r.body.booking.paidWith, "WALLET");
  assert.equal(r.body.payment.paid, true);
  assert.equal(r.body.payment.walletBalanceVnd, 200_000);
  assert.equal(walletBalance("c1"), 200_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "paid");
  assert.equal(events[0].booking.id, r.body.booking.id);
  assert.equal(events[0].order, null);
});

test("a short wallet gives the slot back, and the wallet route works on its own too", async () => {
  adjustWallet("c1", 50_000, "ít", NOW);
  const short = await call("POST", "/api/bookings", { as: "c1", body: order({ payWith: "wallet" }) });
  assert.equal(short.status, 402);
  assert.equal(code(short), "WALLET_LOW");
  assert.equal(getDb().prepare("SELECT status FROM bookings").get().status, "CANCELLED");
  assert.equal(walletBalance("c1"), 50_000);

  adjustWallet("c1", 100_000, "thêm", NOW);
  const made = await call("POST", "/api/bookings", { as: "c1", body: order() });
  assert.equal(made.body.payment.canPayWithWallet, true);
  const paid = await call("POST", `/api/bookings/${made.body.booking.id}/pay-wallet`, { as: "c1", body: {} });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.booking.status, "CONFIRMED");
  assert.equal(paid.body.payment.walletBalanceVnd, 50_000);
  assert.equal(events.length, 1);
  assert.equal(code(await call("POST", `/api/bookings/${made.body.booking.id}/pay-wallet`, { as: "c1", body: {} })), "ILLEGAL_TRANSITION", "no second payment");
});

test("a payment link is made when a gateway is on, and payment_unavailable says so when none is", async () => {
  const link = await call("POST", "/api/bookings", { as: "c1", body: order({ payWith: "link" }) });
  assert.equal(link.status, 201);
  assert.equal(link.body.payment.checkoutUrl, "https://pay.example.test/checkout/1");
  assert.equal(link.body.booking.status, "AWAITING_PAYMENT");
  const again = await call("POST", `/api/bookings/${link.body.booking.id}/pay-link`, { as: "c1", body: {} });
  assert.equal(again.body.payment.checkoutUrl, "https://pay.example.test/checkout/1", "the open link is reused");

  const keys = { ...config.payos };
  Object.assign(config.payos, { clientId: null, apiKey: null, checksumKey: null });
  try {
    const none = await call("POST", "/api/bookings", { as: "c1", body: order({ payWith: "link", startAt: startAt + 5 * HOUR }) });
    assert.equal(none.status, 503);
    assert.equal(code(none), "payment_unavailable");
    const latest = getDb().prepare("SELECT status FROM bookings ORDER BY id DESC").get();
    assert.equal(latest.status, "CANCELLED", "no unpayable booking is left holding the slot");
    const plain = await call("POST", "/api/bookings", { as: "c1", body: order({ startAt: startAt + 8 * HOUR }) });
    assert.equal(plain.body.payment.canPayByLink, false);
    assert.equal(code(await call("POST", `/api/bookings/${plain.body.booking.id}/pay-link`, { as: "c1", body: {} })), "payment_unavailable");
    assert.equal(getBooking(plain.body.booking.id).status, "AWAITING_PAYMENT", "the booking stays so the wallet or a later link can still pay it");
    assert.equal((await call("GET", "/api/config")).body.payByLink, false);
  } finally {
    Object.assign(config.payos, keys);
  }
});

test("the important refusals come back with their own code and the Vietnamese message", async () => {
  const send = (extra = {}, as = "c1") => (resetLimits(), call("POST", "/api/bookings", { as, body: order(extra) }));

  // 18+ not confirmed
  const newcomer = await send({}, "newcomer");
  assert.equal(newcomer.status, 403);
  assert.equal(code(newcomer), "NOT_ATTESTED");
  assert.equal(newcomer.body.error.message, "Bạn cần xác nhận mình đủ 18 tuổi trước khi tiếp tục.");

  // blacklisted
  makeCustomer("bad");
  addToBlacklist("bad", "thử", "staff", NOW);
  assert.equal(code(await send({}, "bad")), "BLACKLISTED");

  // a past slot and one inside the lead time
  assert.equal(code(await send({ startAt: NOW - HOUR })), "IN_PAST");
  assert.equal(code(await send({ startAt: NOW + 30 * MIN })), "TOO_SOON");
  assert.equal(code(await send({ startAt: NOW + 40 * DAY })), "TOO_FAR");
  assert.equal(code(await send({ startAt: startAt + 7 * MIN })), "BAD_START");

  // outside the player's hours
  makePlayer("p8", { availability: "T2 19:00-23:00" });
  assert.equal(code(await send({ playerId: "p8" })), "OUTSIDE_AVAILABILITY");

  // paused player, unknown player, unknown game
  makePlayer("p9", { status: "PAUSED" });
  assert.equal(code(await send({ playerId: "p9" })), "PLAYER_NOT_ACTIVE");
  assert.equal(code(await send({ playerId: "ghost" })), "NOT_FOUND");
  assert.equal(code(await send({ game: "Cờ vua" })), "GAME_NOT_OFFERED");
  assert.equal(code(await send({ playerId: "c1" })), "SELF_BOOKING");

  // a slot somebody else already holds
  makeCustomer("c2");
  const first = await send({}, "c2");
  assert.equal(first.status, 201);
  const taken = await send();
  assert.equal(taken.status, 409);
  assert.equal(code(taken), "PLAYER_BUSY");
  assert.equal(taken.body.error.message, "Player đã có lịch khác trong khung giờ này.");

  // the same person cannot be in two places
  makePlayer("p10");
  makePlayer("p12");
  assert.equal((await send({ playerId: "p10" })).status, 201);
  assert.equal(code(await send({ playerId: "p12" })), "CUSTOMER_BUSY");

  // bad input never reaches the rules
  assert.equal(code(await send({ durationMin: "1" })), "INVALID_INPUT");
  assert.equal(code(await send({ playerId: { $ne: 1 } })), "INVALID_INPUT");
  assert.equal(code(await send({ payWith: "bitcoin" })), "INVALID_INPUT");
  assert.equal(code(await send({ coupon: "NOPE" , startAt: startAt + 2 * DAY })), "COUPON_INVALID");
});

test("at most the allowed number of unfinished bookings", async () => {
  saveSettings({ maxActiveBookings: 2 });
  for (let i = 0; i < 2; i += 1) assert.equal((await call("POST", "/api/bookings", { as: "c1", body: order({ startAt: startAt + i * 3 * HOUR }) })).status, 201);
  const third = await call("POST", "/api/bookings", { as: "c1", body: order({ startAt: startAt + 9 * HOUR }) });
  assert.equal(third.status, 409);
  assert.equal(code(third), "TOO_MANY_ACTIVE");
});

test("a visitor who is not on the Discord server is asked to join first", async () => {
  const guild = { members: { fetch: async () => { throw Object.assign(new Error("Unknown Member"), { code: 10007 }); } } };
  await web.close();
  web = createWebServer({ client: { guilds: { cache: new Map([[config.guildId, guild]]) }, notifyBooking: async () => {} }, now: () => clock });
  base = `http://127.0.0.1:${await web.listen(0, "127.0.0.1")}`;
  const r = await call("POST", "/api/bookings", { as: "c1", body: order() });
  assert.equal(r.status, 403);
  assert.equal(code(r), "NOT_IN_SERVER");
  assert.equal(r.body.error.inviteUrl, "https://discord.gg/example");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);
});

// ---------------------------------------------------------------- cancel and rate

test("cancelling follows the Discord rules: free before payment, tiers after, and only by the customer", async () => {
  const unpaid = await call("POST", "/api/bookings", { as: "c1", body: order() });
  const free = await call("POST", `/api/bookings/${unpaid.body.booking.id}/cancel`, { as: "c1", body: {} });
  assert.equal(free.status, 200);
  assert.equal(free.body.booking.status, "CANCELLED");
  assert.equal(free.body.refundVnd, 0);
  assert.equal(code(await call("POST", `/api/bookings/${unpaid.body.booking.id}/cancel`, { as: "c1", body: {} })), "ILLEGAL_TRANSITION");

  const paid = confirmed({ customerId: "c1", startAt: NOW + 3 * DAY, durationMin: 60 });
  const listed = (await call("GET", "/api/me", { as: "c1" })).body.bookings.find((b) => b.id === paid.id);
  assert.equal(listed.canCancel, true);
  assert.equal(listed.refund.percent, 100, "the preview shows what cancelling now would refund");
  makeCustomer("c2");
  assert.equal(code(await call("POST", `/api/bookings/${paid.id}/cancel`, { as: "c2", body: {} })), "NOT_FOUND", "somebody else's booking looks like none");
  assert.equal(getBooking(paid.id).status, "CONFIRMED");
  const done = await call("POST", `/api/bookings/${paid.id}/cancel`, { as: "c1", body: {} });
  assert.equal(done.body.refundVnd, 100_000);
  assert.equal(done.body.percent, 100);
  const rows = getDb().prepare("SELECT kind, amount_vnd FROM ledger WHERE booking_id = ?").all(paid.id);
  assert.ok(rows.some((r) => r.kind === "REFUND" && r.amount_vnd === 100_000), "the refund is in the ledger exactly as for a Discord cancel");

  // a late cancellation gets the tier of the policy
  const late = confirmed({ customerId: "c1", startAt: NOW + 2 * HOUR, durationMin: 60 });
  const lateAnswer = await call("POST", `/api/bookings/${late.id}/cancel`, { as: "c1", body: {} });
  assert.ok(lateAnswer.body.percent < 100);
  assert.equal(lateAnswer.body.refundVnd, Math.floor((100_000 * lateAnswer.body.percent) / 100));
  assert.equal(code(await call("POST", "/api/bookings/abc/cancel", { as: "c1", body: {} })), "NOT_FOUND");
});

test("rating works once on a finished session by its customer", async () => {
  const b = confirmed({ customerId: "c1", startAt: NOW + 3 * HOUR, durationMin: 60 });
  assert.equal(code(await call("POST", `/api/bookings/${b.id}/rate`, { as: "c1", body: { stars: 5 } })), "NOT_RATEABLE");
  start(b.id, SYSTEM, NOW + 3 * HOUR);
  complete(b.id, SYSTEM, NOW + 4 * HOUR);
  clock = NOW + 4 * HOUR + MIN;
  const view = (await call("GET", "/api/me", { as: "c1" })).body.bookings[0];
  assert.equal(view.canRate, true);
  assert.equal(code(await call("POST", `/api/bookings/${b.id}/rate`, { as: "c1", body: { stars: 9 } })), "BAD_STARS");
  assert.equal(code(await call("POST", `/api/bookings/${b.id}/rate`, { as: "c1", body: { stars: "5" } })), "INVALID_INPUT");
  makeCustomer("c2");
  assert.equal(code(await call("POST", `/api/bookings/${b.id}/rate`, { as: "c2", body: { stars: 5 } })), "NOT_FOUND");
  const ok = await call("POST", `/api/bookings/${b.id}/rate`, { as: "c1", body: { stars: 5, review: "Rất vui @everyone https://spam.example" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.count, 1);
  assert.equal(ok.body.average, 5);
  assert.equal(getBooking(b.id).review, "Rất vui");
  assert.equal(code(await call("POST", `/api/bookings/${b.id}/rate`, { as: "c1", body: { stars: 4 } })), "ALREADY_RATED");
  assert.equal(getPlayer("p1").ratingCount, 1);
  clock = NOW + 4 * HOUR + 3 * DAY;
  const closed = confirmed({ customerId: "c1", startAt: NOW + 6 * HOUR, durationMin: 60, now: NOW });
  start(closed.id, SYSTEM, NOW + 6 * HOUR);
  complete(closed.id, SYSTEM, NOW + 7 * HOUR);
  assert.equal(code(await call("POST", `/api/bookings/${closed.id}/rate`, { as: "c1", body: { stars: 4 } })), "REVIEW_CLOSED");
});

// ---------------------------------------------------------------- the player portal

test("only a player can use the portal", async () => {
  for (const [method, path, body] of [["GET", "/api/me/player"], ["GET", "/api/me/availability"], ["PUT", "/api/me/availability", { text: "T2 19:00-21:00" }], ["POST", "/api/me/status", { status: "PAUSED" }]]) {
    const r = await call(method, path, { as: "c1", body });
    assert.equal(r.status, 403, path);
    assert.equal(code(r), "NOT_A_PLAYER");
  }
  assert.equal((await call("GET", "/api/me/player")).status, 401);
  makePlayer("p11", { status: "PENDING" });
  assert.equal(code(await call("GET", "/api/me/player", { as: "p11" })), "NOT_A_PLAYER");
});

test("a player reads and edits the weekly hours, with mistakes explained", async () => {
  const read = await call("GET", "/api/me/availability", { as: "p1" });
  assert.equal(read.status, 200);
  assert.match(read.body.availability.text, /^T2 00:00-24:00;/);
  assert.equal(read.body.availability.slots.length, 7);

  const write = await call("PUT", "/api/me/availability", { as: "p1", body: { text: "T2 19:00-23:00; CN 09:00-12:00" } });
  assert.equal(write.status, 200);
  assert.equal(write.body.availability.text, "T2 19:00-23:00; CN 09:00-12:00");
  assert.deepEqual(getAvailability("p1").map((s) => [s.weekday, s.startMin, s.endMin]), [[0, 540, 720], [1, 1140, 1380]]);

  const bad = await call("PUT", "/api/me/availability", { as: "p1", body: { text: "T9 19:00-23:00" } });
  assert.equal(bad.status, 400);
  assert.equal(code(bad), "BAD_AVAILABILITY");
  assert.ok(bad.body.error.errors.length > 0);
  assert.equal(getAvailability("p1").length, 2, "a wrong text stores nothing");
  assert.equal(code(await call("PUT", "/api/me/availability", { as: "p1", body: {} })), "INVALID_INPUT");
});

test("a player can pause and resume, and a paused player disappears from the site", async () => {
  const paused = await call("POST", "/api/me/status", { as: "p1", body: { status: "PAUSED" } });
  assert.equal(paused.body.status, "PAUSED");
  assert.deepEqual((await call("GET", "/api/players")).body.players, []);
  assert.equal(code(await call("POST", "/api/bookings", { as: "c1", body: order() })), "PLAYER_NOT_ACTIVE");
  assert.equal((await call("GET", "/api/me/player", { as: "p1" })).status, 200, "a paused player still has the portal");
  assert.equal(code(await call("POST", "/api/me/status", { as: "p1", body: { status: "PAUSED" } })), "ILLEGAL_TRANSITION");
  assert.equal((await call("POST", "/api/me/status", { as: "p1", body: { status: "ACTIVE" } })).body.status, "ACTIVE");
  assert.equal(code(await call("POST", "/api/me/status", { as: "p1", body: { status: "BANNED" } })), "INVALID_INPUT");
  assert.equal(getPlayer("p1").status, "ACTIVE");
});

test("the portal shows upcoming bookings and what the player is owed, without customer identities", async () => {
  const b = confirmed({ customerId: "c1", startAt: NOW + 3 * HOUR, durationMin: 60 });
  const doneStart = NOW - 3 * HOUR;
  makeCustomer(CUSTOMER);
  const old = confirmed({ customerId: CUSTOMER, startAt: doneStart, durationMin: 60, now: NOW - DAY });
  start(old.id, SYSTEM, doneStart);
  complete(old.id, SYSTEM, doneStart + HOUR);
  const r = await call("GET", "/api/me/player", { as: "p1" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.upcoming.map((x) => x.id), [b.id]);
  assert.deepEqual(r.body.recent.map((x) => x.id), [old.id]);
  assert.equal(r.body.upcoming[0].payoutVnd, 90_000);
  assert.equal(r.body.upcoming[0].customer, "Khách …c1");
  assert.ok(!r.text.includes(CUSTOMER) && !r.text.includes('"c1"'), "no customer id");
  assert.equal(r.body.earnings.owedVnd, 90_000);
  assert.equal(r.body.earnings.releasableVnd + r.body.earnings.heldVnd, 90_000);
  assert.equal(r.body.player.status, "ACTIVE");
});

test("the owner's token route and the webhook paths are not shadowed by the API", async () => {
  config.web.dashboardToken = "owner-token-123";
  const stats = await call("GET", "/api/stats?token=owner-token-123");
  assert.equal(stats.status, 200);
  assert.ok("revenue" in stats.body || Object.keys(stats.body).length > 0);
  assert.equal((await call("POST", "/webhook/payos", { raw: "{}" })).status, 401);
  assert.equal((await call("GET", "/dashboard?token=owner-token-123")).status, 200);
});

test("with only bank transfer on, the page gets the account, the amount, the note and a QR, and 'transferred' asks the owner", async () => {
  const keys = { ...config.payos };
  const wanted = config.paymentProvider;
  Object.assign(config.payos, { clientId: null, apiKey: null, checksumKey: null });
  config.paymentProvider = null;
  try {
    assert.equal((await call("GET", "/api/config")).body.payByLink, false, "off until the owner saves an account");
    setBank("owner", { bank: "MB", accountNo: "0123456789", accountName: "Nguyen Van A" }, NOW);
    const cfg = (await call("GET", "/api/config")).body;
    assert.equal(cfg.payByLink, true);
    assert.equal(cfg.payProvider, "manual");
    const made = await call("POST", "/api/bookings", { as: "c1", body: order({ payWith: "link" }) });
    assert.equal(made.status, 201);
    const manual = made.body.payment.manual;
    assert.equal(manual.bankName, "MB Bank");
    assert.equal(manual.accountNo, "0123456789");
    assert.equal(manual.amountVnd, 100_000);
    assert.match(manual.note, /^BOOK\d{5}$/);
    assert.match(manual.qrUrl, /^https:\/\/img\.vietqr\.io\/image\/970422-0123456789-compact2\.png\?/);
    assert.equal(made.body.booking.status, "AWAITING_PAYMENT", "nothing is paid until the owner confirms");

    const again = await call("POST", `/api/bookings/${made.body.booking.id}/pay-link`, { as: "c1", body: {} });
    assert.equal(again.body.payment.manual.orderCode, manual.orderCode, "the same order is reused");

    assert.equal((await call("POST", `/api/bookings/${made.body.booking.id}/transferred`, { as: "c1", body: {}, origin: "https://evil.example" })).status, 403);
    const told = await call("POST", `/api/bookings/${made.body.booking.id}/transferred`, { as: "c1", body: {} });
    assert.equal(told.status, 200);
    assert.deepEqual(events.map((e) => e.kind), ["manual_told"]);
    assert.equal(events[0].order.order_code, manual.orderCode);
    assert.equal(code(await call("POST", `/api/bookings/${made.body.booking.id}/transferred`, { as: "c2", body: {} })), "NOT_FOUND", "somebody else cannot even see the booking");
  } finally {
    Object.assign(config.payos, keys);
    config.paymentProvider = wanted;
  }
});
