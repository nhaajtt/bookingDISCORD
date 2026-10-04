import { config } from "../config.js";
import { getSettings } from "../settings.js";
import { DomainError, fail } from "../domain/errors.js";
import { hasAttested } from "../domain/attestations.js";
import { formatAvailability, getAvailability } from "../domain/availability.js";
import { SYSTEM, cancel, createBooking, getBooking, listBookings } from "../domain/bookings.js";
import { normalizeCode } from "../domain/coupons.js";
import { owedTo, pendingPayouts } from "../domain/ledger.js";
import { getPlayer, listPlayers, pausePlayer, resumePlayer, setAvailabilityText } from "../domain/players.js";
import { quoteBooking } from "../domain/quoting.js";
import { recordRating, sanitizeText } from "../domain/ratings.js";
import { SORTS, searchPlayers } from "../domain/search.js";
import { DAY, MINUTE } from "../domain/time.js";
import { listForCustomer, slotIsFree } from "../domain/waitlist.js";
import { payFromWallet, walletBalance } from "../domain/wallet.js";
import { anyProviderEnabled } from "../pay/gateway.js";
import { checkoutBooking } from "../pay/checkout.js";
import { refreshCard } from "../discord/cards.js";
import { getGuild } from "../discord/guild.js";
import { LIMITS, hit } from "../discord/limits.js";
import { cancelAndNotify, publishReview } from "../flows/booking.js";
import { log } from "../log.js";
import { SESSION_COOKIE, SESSION_TTL_MS, STATE_COOKIE, STATE_TTL_MS, clearCookie, cookie, newState, parseCookies, sameText, signToken, verifyToken } from "./session.js";
import { customerBooking, freeSlots, playerBooking, publicPlayer } from "./views.js";

// The JSON API behind the public booking site. The site is on another origin, but the browser only ever talks to its own origin:
// the host rewrites /api/* to this server, so the cookies below are first-party and there is no CORS at all. What keeps a stranger's
// page from acting for a logged-in visitor is SameSite=Lax plus the Origin check on every request that is not a GET.
//
//   public         GET  /api/config, /api/players, /api/players/:id      POST /api/quote
//   login          GET  /api/auth/login, /api/auth/callback              POST /api/auth/logout
//   customer       GET  /api/me                                          POST /api/bookings, /api/bookings/:id/{pay-wallet,pay-link,cancel,rate}
//   player portal  GET  /api/me/player, /api/me/availability            PUT  /api/me/availability      POST /api/me/status
//
// Every rule (overlap, lead time, strikes, blacklist, the 18+ confirmation, active-booking cap, refunds) lives in src/domain and is
// the same code the Discord flow calls. Errors are { error: { code, message } } with the Vietnamese message of the DomainError.

const MAX_BODY = 16 * 1024;
const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE = /^\d{17,20}$/;
const ID = /^[\w-]{1,40}$/;

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Which HTTP status a refused rule gets; anything not listed is a plain 400
const STATUS_OF = {
  NOT_FOUND: 404,
  FORBIDDEN_ACTOR: 403,
  NOT_ATTESTED: 403,
  BLACKLISTED: 403,
  PLAYER_SUSPENDED: 403,
  PLAYER_BUSY: 409,
  CUSTOMER_BUSY: 409,
  SLOT_HELD: 409,
  TOO_MANY_ACTIVE: 409,
  ILLEGAL_TRANSITION: 409,
  ORDER_EXISTS: 409,
  ALREADY_RATED: 409,
  WALLET_LOW: 402,
};

const authReady = () => Boolean(config.web.discordClientSecret && config.web.sessionSecret && config.web.siteUrl && config.clientId);
const secure = () => String(config.web.siteUrl ?? "").startsWith("https:");

// ---------------------------------------------------------------- plumbing

function reply(res, status, value, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    vary: "Cookie, Origin",
    ...headers,
  });
  res.end(JSON.stringify(value));
  return true;
}

function failure(res, error) {
  if (error instanceof ApiError) {
    const { close, ...extra } = error.extra;
    return reply(res, error.status, { error: { code: error.code, message: error.message, ...extra } }, { ...(error.status === 429 ? { "retry-after": "30" } : {}), ...(close ? { connection: "close" } : {}) });
  }
  if (error instanceof DomainError) return reply(res, STATUS_OF[error.code] ?? 400, { error: { code: error.code, message: error.message } });
  // Never a stack trace or a database message in the answer
  log.error("web.api_failed", { error });
  return reply(res, 500, { error: { code: "SERVER_ERROR", message: "Có lỗi ở phía hệ thống, bạn thử lại sau ít phút nhé." } });
}

function readJson(request) {
  const type = String(request.headers["content-type"] ?? "");
  if (!/^application\/json\b/i.test(type)) {
    request.resume();
    throw new ApiError(415, "BAD_CONTENT_TYPE", "Yêu cầu phải ở dạng JSON.");
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      // Past the limit nothing more is kept; the rest is read and thrown away so the 413 can still be delivered
      if (size > MAX_BODY) reject(new ApiError(413, "TOO_LARGE", "Yêu cầu quá lớn.", { close: true }));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
        resolve(value);
      } catch {
        reject(new ApiError(400, "BAD_JSON", "Dữ liệu gửi lên không đọc được."));
      }
    });
    request.on("error", reject);
  });
}

// The address to rate limit: the first hop the host reports, else the socket
function clientIp(request) {
  const first = String(request.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return /^[0-9a-f:.]{3,45}$/i.test(first) ? first : (request.socket?.remoteAddress ?? "unknown");
}

// Sliding-window limit under its own key space, so the Discord buckets are untouched
function limit(key, max, windowMs, at, message = "Bạn thao tác nhanh quá, đợi vài giây rồi thử lại nhé.") {
  if (!hit(`web:${key}`, max, windowMs, at)) throw new ApiError(429, "RATE_LIMITED", message);
}
function bucket(name, userId, at) {
  const [max, windowMs, message] = LIMITS[name];
  limit(`${name}:${userId}`, max, windowMs, at, message);
}

// Every request that is not a GET must come from the site itself
function checkOrigin(request) {
  const site = config.web.siteUrl;
  if (!site) throw new ApiError(503, "WEB_DISABLED", "Trang web đặt lịch chưa được bật.");
  const given = request.headers.origin ?? (request.headers.referer ? safeOrigin(request.headers.referer) : null);
  if (!given || !sameText(given, new URL(site).origin)) throw new ApiError(403, "BAD_ORIGIN", "Yêu cầu không đến từ trang đặt lịch.");
}
function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function sessionOf(request, at) {
  const secret = config.web.sessionSecret;
  if (!secret) return null;
  const payload = verifyToken(secret, "s", parseCookies(request.headers.cookie)[SESSION_COOKIE], at);
  return payload && typeof payload.uid === "string" ? { id: payload.uid, name: String(payload.name ?? "") } : null;
}

function requireUser(request, at) {
  if (!authReady()) throw new ApiError(503, "WEB_DISABLED", "Đăng nhập trên web chưa được bật.");
  const user = sessionOf(request, at);
  if (!user) throw new ApiError(401, "LOGIN_REQUIRED", "Bạn cần đăng nhập bằng Discord.");
  limit(`user:${user.id}`, 90, 60_000, at);
  return user;
}

const text = (value, max, label) => {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_INPUT", `Thiếu ${label}.`);
  return sanitizeText(value, max);
};
const whole = (value, label) => {
  if (!Number.isInteger(value)) throw new ApiError(400, "INVALID_INPUT", `${label} không hợp lệ.`);
  return value;
};
const idOf = (value, label) => {
  if (typeof value !== "string" || !ID.test(value)) throw new ApiError(400, "INVALID_INPUT", `${label} không hợp lệ.`);
  return value;
};
const bookingIdOf = (raw) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(404, "NOT_FOUND", "Không tìm thấy lịch yêu cầu.");
  return id;
};
// Somebody else's booking looks exactly like one that does not exist
function ownBooking(id, userId) {
  const booking = getBooking(id);
  if (!booking || booking.customer_id !== userId) fail("NOT_FOUND", { what: "lịch" });
  return booking;
}

// A person who is not on the Discord server cannot be put in a private room, so they are asked to join first. Unknown (the bot
// cannot reach the server right now) counts as a member: the room job reports its own failure.
async function isMember(client, userId) {
  const guild = await getGuild(client);
  if (!guild?.members?.fetch) return true;
  try {
    await guild.members.fetch(userId);
    return true;
  } catch (error) {
    return !(error?.code === 10007 || error?.status === 404);
  }
}

const safeNext = (value) => (typeof value === "string" && /^\/(?![/\\])[\w\-./?=&%#]{0,200}$/.test(value) ? value : "/");

// ---------------------------------------------------------------- login

function login(request, res, url, at) {
  if (!authReady()) throw new ApiError(503, "WEB_DISABLED", "Đăng nhập trên web chưa được bật.");
  limit(`login:${clientIp(request)}`, 20, 10 * 60_000, at);
  const state = newState();
  const token = signToken(config.web.sessionSecret, "o", { s: state, n: safeNext(url.searchParams.get("next")) }, STATE_TTL_MS, at);
  const target = new URL("https://discord.com/oauth2/authorize");
  target.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: `${config.web.siteUrl}/api/auth/callback`,
    state,
    prompt: "none",
  }).toString();
  return redirect(res, target.toString(), [cookie(STATE_COOKIE, token, { maxAgeMs: STATE_TTL_MS, secure: secure() })]);
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, "cache-control": "no-store", "set-cookie": cookies, "referrer-policy": "no-referrer" });
  res.end();
  return true;
}

// The one place the Discord token is handled: it is used for a single request to learn who this is and then dropped, never stored or logged
async function discordUser(code) {
  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.web.discordClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: `${config.web.siteUrl}/api/auth/callback`,
  });
  const token = await fetch(`${DISCORD_API}/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(8000) });
  if (!token.ok) throw new Error(`discord token ${token.status}`);
  const { access_token: accessToken } = await token.json();
  if (typeof accessToken !== "string") throw new Error("discord token missing");
  const me = await fetch(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) });
  if (!me.ok) throw new Error(`discord user ${me.status}`);
  const user = await me.json();
  if (!SNOWFLAKE.test(String(user?.id))) throw new Error("discord user id");
  return { id: user.id, name: sanitizeText(user.global_name || user.username || "", 32) };
}

async function callback(request, res, url, at) {
  if (!authReady()) throw new ApiError(503, "WEB_DISABLED", "Đăng nhập trên web chưa được bật.");
  limit(`login:${clientIp(request)}`, 20, 10 * 60_000, at);
  const site = config.web.siteUrl;
  const clear = clearCookie(STATE_COOKIE, secure());
  const saved = verifyToken(config.web.sessionSecret, "o", parseCookies(request.headers.cookie)[STATE_COOKIE], at);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error")) return redirect(res, `${site}/?login=cancelled`, [clear]);
  if (!saved || !state || !code || !sameText(state, saved.s) || code.length > 200) return redirect(res, `${site}/?login=failed`, [clear]);
  let user;
  try {
    user = await discordUser(code);
  } catch (error) {
    // Only the reason, never a token or the code
    log.warn("web.login_failed", { reason: error.message });
    return redirect(res, `${site}/?login=failed`, [clear]);
  }
  const session = signToken(config.web.sessionSecret, "s", { uid: user.id, name: user.name }, SESSION_TTL_MS, at);
  return redirect(res, `${site}${safeNext(saved.n)}`, [clear, cookie(SESSION_COOKIE, session, { maxAgeMs: SESSION_TTL_MS, secure: secure() })]);
}

// ---------------------------------------------------------------- public reads

function siteConfig(request, at) {
  const settings = getSettings();
  const viewer = sessionOf(request, at);
  const games = new Map();
  for (const p of listPlayers({ status: "ACTIVE" })) for (const g of p.games) games.set(g, (games.get(g) ?? 0) + 1);
  const gate = settings.channels.ageGateChannelId && config.guildId ? `https://discord.com/channels/${config.guildId}/${settings.channels.ageGateChannelId}` : null;
  return {
    loginEnabled: authReady(),
    viewer,
    timezone: settings.timezone,
    stepMin: 30,
    minLeadMin: settings.minLeadMin,
    maxAdvanceDays: settings.maxAdvanceDays,
    maxDurationMin: settings.maxDurationHours * 60,
    unpaidExpireMin: settings.unpaidExpireMin,
    payByLink: anyProviderEnabled(),
    discord: { ageGateUrl: gate, inviteUrl: config.web.discordInviteUrl },
    games: [...games.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, players]) => ({ name, players })),
  };
}

function players(url, at) {
  const settings = getSettings();
  const game = sanitizeText(url.searchParams.get("game") ?? "", 40) || null;
  const q = sanitizeText(url.searchParams.get("q") ?? "", 40).toLowerCase();
  const sortParam = url.searchParams.get("sort");
  const found = searchPlayers({ game, freeNow: url.searchParams.get("free") === "1", sort: SORTS.includes(sortParam) ? sortParam : "diem", limit: 200 }, at, settings);
  const rows = found
    .filter((p) => !q || [p.displayName, p.bio, p.games.join(" ")].join(" ").toLowerCase().includes(q))
    .slice(0, 60)
    .map((p) => publicPlayer(p, { freeNow: p.freeNow, nextFreeAt: p.nextFreeAt }, at, settings));
  return { players: rows, now: at };
}

function playerDetail(id, at) {
  const settings = getSettings();
  const p = getPlayer(id);
  if (!p || p.status !== "ACTIVE") fail("NOT_FOUND", { what: "player" });
  return { player: publicPlayer(p, {}, at, settings), days: freeSlots(p.userId, at, settings), now: at };
}

function quote(body, user, at) {
  const settings = getSettings();
  const playerId = idOf(body.playerId, "Player");
  const player = getPlayer(playerId);
  if (!player || player.status !== "ACTIVE") fail("PLAYER_NOT_ACTIVE");
  const wanted = text(body.game, 40, "game").toLowerCase();
  const game = player.games.find((g) => g.toLowerCase() === wanted);
  if (!game) fail("GAME_NOT_OFFERED");
  const startAt = whole(body.startAt, "Giờ bắt đầu");
  const durationMin = whole(body.durationMin, "Thời lượng");
  const couponCode = body.coupon ? normalizeCode(text(String(body.coupon), 20, "mã giảm giá")) : null;
  if (couponCode) {
    if (!user) throw new ApiError(401, "LOGIN_REQUIRED", "Đăng nhập để dùng mã giảm giá.");
    bucket("coupon", user.id, at);
  }
  const q = quoteBooking({ player, game, startAt, durationMin, couponCode, userId: user?.id ?? null, now: at }, settings);
  return {
    game,
    startAt,
    durationMin,
    rateVnd: q.rateVnd,
    listPriceVnd: q.listPriceVnd,
    surchargeVnd: q.surchargeVnd,
    discountVnd: q.discountVnd,
    priceVnd: q.priceVnd,
    feeVnd: q.feeVnd,
    couponCode: q.coupon?.code ?? null,
    couponCapped: q.couponCapped,
    available: slotIsFree(playerId, startAt, durationMin, at, settings),
  };
}

// ---------------------------------------------------------------- the logged-in customer

function me(user, at) {
  const settings = getSettings();
  const player = getPlayer(user.id);
  const bookings = listBookings({ customerId: user.id, from: at - 60 * DAY, limit: 100 }).sort((a, b) => b.start_at - a.start_at);
  return {
    user,
    attested: hasAttested(user.id),
    wallet: { balanceVnd: walletBalance(user.id) },
    bookings: bookings.map((b) => customerBooking(b, at, settings, config.guildId)),
    waitlist: listForCustomer(user.id).map((w) => ({ id: w.id, playerId: w.playerId, playerName: getPlayer(w.playerId)?.displayName ?? "Player", game: w.game, startAt: w.startAt, durationMin: w.durationMin, notified: w.notifiedAt !== null })),
    player: player && ["ACTIVE", "PAUSED"].includes(player.status) ? { status: player.status } : null,
  };
}

async function notifyPaid(client, booking) {
  try {
    await client?.notifyBooking?.({ kind: "paid", booking, order: null });
  } catch (error) {
    log.error("web.notify_failed", { booking: booking.id, error });
  }
}

// A payment link for an unpaid booking, or the reason there is none
async function linkFor(booking, at, settings) {
  if (!anyProviderEnabled()) throw new ApiError(503, "payment_unavailable", "Thanh toán bằng link chưa mở. Bạn có thể thanh toán bằng ví hoặc quay lại sau nhé.");
  try {
    const made = await checkoutBooking(booking, at, null, settings);
    return made.checkoutUrl;
  } catch (error) {
    log.error("web.payment_link_failed", { booking: booking.id, error });
    throw new ApiError(502, "payment_unavailable", "Hệ thống thanh toán đang bận, bạn thử lại sau ít phút nhé.");
  }
}

async function createFromWeb(client, user, body, at) {
  const settings = getSettings();
  bucket("book", user.id, at);
  const input = {
    customerId: user.id,
    playerId: idOf(body.playerId, "Player"),
    game: text(body.game, 40, "game"),
    startAt: whole(body.startAt, "Giờ bắt đầu"),
    durationMin: whole(body.durationMin, "Thời lượng"),
    couponCode: body.coupon ? normalizeCode(text(String(body.coupon), 20, "mã giảm giá")) : null,
  };
  const payWith = body.payWith ?? null;
  if (payWith !== null && payWith !== "wallet" && payWith !== "link") throw new ApiError(400, "INVALID_INPUT", "Cách thanh toán không hợp lệ.");
  if (input.couponCode) bucket("coupon", user.id, at);
  // The same rule order as the Discord form: refuse people who cannot book before asking anything of the server
  if (!hasAttested(user.id)) fail("NOT_ATTESTED");
  if (!(await isMember(client, user.id))) throw new ApiError(403, "NOT_IN_SERVER", "Bạn cần vào server Discord của bọn mình trước khi đặt lịch.", { inviteUrl: config.web.discordInviteUrl });
  const booking = createBooking(input, at, settings);

  const balance = walletBalance(user.id);
  const payment = { walletBalanceVnd: balance, canPayWithWallet: balance >= booking.price_vnd, canPayByLink: anyProviderEnabled(), checkoutUrl: null };
  if (payWith === "wallet") {
    let paid;
    try {
      paid = payFromWallet(booking.id, user.id, at);
    } catch (error) {
      // The customer asked for the wallet and it is short: nothing was paid, so the slot goes back
      if (error.code === "WALLET_LOW") cancel(booking.id, SYSTEM, at, { reason: "ví không đủ" });
      throw error;
    }
    await notifyPaid(client, paid.booking);
    return { booking: customerBooking(getBooking(booking.id), at, settings, config.guildId), payment: { ...payment, walletBalanceVnd: paid.balance, paid: true } };
  }
  if (payWith === "link") {
    try {
      payment.checkoutUrl = await linkFor(booking, at, settings);
    } catch (error) {
      // Nothing was paid and no link exists: give the slot back, as the Discord flow does
      try {
        cancel(booking.id, SYSTEM, at, { reason: "không tạo được link thanh toán" });
      } catch (inner) {
        log.error("web.cancel_after_link_failure_failed", { booking: booking.id, error: inner });
      }
      throw error;
    }
  }
  return { booking: customerBooking(getBooking(booking.id), at, settings, config.guildId), payment: { ...payment, paid: false } };
}

async function cancelFromWeb(client, user, id, at) {
  const settings = getSettings();
  bucket("any", user.id, at);
  const before = ownBooking(id, user.id);
  const result = await cancelAndNotify(await getGuild(client), client, before.id, { role: "customer", userId: user.id }, null);
  return { booking: customerBooking(getBooking(before.id), at, settings, config.guildId), refundVnd: result.refundVnd, percent: result.percent };
}

async function rateFromWeb(client, user, id, body, at) {
  bucket("rate", user.id, at);
  const stars = whole(body.stars, "Số sao");
  const review = body.review === undefined ? "" : text(body.review, 300, "nhận xét");
  ownBooking(id, user.id);
  const { booking, player } = recordRating(id, user.id, stars, review, at);
  await publishReview(await getGuild(client), booking, player, stars).catch((error) => log.error("web.review_publish_failed", { error }));
  return { ok: true, average: player.average, count: player.count };
}

// ---------------------------------------------------------------- the player portal

function mustBePlayer(user) {
  const player = getPlayer(user.id);
  if (!player || !["ACTIVE", "PAUSED"].includes(player.status)) throw new ApiError(403, "NOT_A_PLAYER", "Chỉ player đang hoạt động mới dùng được cổng này.");
  return player;
}

function portal(user, at) {
  const player = mustBePlayer(user);
  const slots = getAvailability(user.id);
  const upcoming = listBookings({ playerId: user.id, statuses: ["CONFIRMED", "IN_PROGRESS"], from: at - DAY, limit: 100 });
  const recent = listBookings({ playerId: user.id, statuses: ["COMPLETED"], from: at - 14 * DAY, limit: 50 }).sort((a, b) => b.start_at - a.start_at);
  const owed = owedTo(user.id);
  const releasable = pendingPayouts(at).filter((r) => r.party_user_id === user.id).reduce((n, r) => n + r.amount_vnd, 0);
  return {
    player: { id: user.id, name: player.displayName, status: player.status, rating: { average: player.average, count: player.ratingCount }, completed: player.completed },
    availability: { text: formatAvailability(slots), slots },
    upcoming: upcoming.map(playerBooking),
    recent: recent.map(playerBooking),
    earnings: { owedVnd: owed.payoutVnd, releasableVnd: releasable, heldVnd: Math.max(0, owed.payoutVnd - releasable) },
  };
}

async function setHours(client, user, body, at) {
  mustBePlayer(user);
  bucket("avail", user.id, at);
  const parsed = setAvailabilityText(user.id, text(body.text, 400, "lịch rảnh"));
  if (!parsed.ok) throw new ApiError(400, "BAD_AVAILABILITY", parsed.errors.join(" "), { errors: parsed.errors });
  await refreshCard(await getGuild(client), user.id).catch((error) => log.error("card.refresh_failed", { user: user.id, error }));
  const slots = getAvailability(user.id);
  return { availability: { text: formatAvailability(slots), slots } };
}

async function setStatus(client, user, body, at) {
  mustBePlayer(user);
  bucket("avail", user.id, at);
  if (body.status !== "PAUSED" && body.status !== "ACTIVE") throw new ApiError(400, "INVALID_INPUT", "Trạng thái phải là PAUSED hoặc ACTIVE.");
  const player = body.status === "PAUSED" ? pausePlayer(user.id) : resumePlayer(user.id);
  await refreshCard(await getGuild(client), user.id).catch((error) => log.error("card.refresh_failed", { user: user.id, error }));
  return { status: player.status };
}

// ---------------------------------------------------------------- routing

// handleApi({ request, res, url, parts, client, now }) -> true when the request was answered
export async function handleApi({ request, res, url, parts, client = null, now = Date.now }) {
  try {
    if (config.multiTenant) throw new ApiError(503, "WEB_DISABLED", "Trang web đặt lịch chưa hỗ trợ chế độ nhiều server.");
    const at = now();
    const method = request.method;
    const path = parts.slice(1).join("/");
    if (method !== "GET" && method !== "POST" && method !== "PUT") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Phương thức không được hỗ trợ.");
    limit(`ip:${clientIp(request)}`, 240, 60_000, at);
    if (method !== "GET") {
      limit(`ipw:${clientIp(request)}`, 60, 60_000, at);
      checkOrigin(request);
    }
    const is = (m, pattern) => (m === method ? pattern.exec(path) : null);
    let m;

    if (is("GET", /^config$/)) return reply(res, 200, siteConfig(request, at));
    if (is("GET", /^players$/)) return reply(res, 200, players(url, at));
    if ((m = is("GET", /^players\/([\w-]{1,40})$/))) return reply(res, 200, playerDetail(m[1], at));
    if (is("POST", /^quote$/)) {
      const body = await readJson(request);
      return reply(res, 200, quote(body, authReady() ? sessionOf(request, at) : null, at));
    }

    if (is("GET", /^auth\/login$/)) return login(request, res, url, at);
    if (is("GET", /^auth\/callback$/)) return await callback(request, res, url, at);
    if (is("POST", /^auth\/logout$/)) return reply(res, 200, { ok: true }, { "set-cookie": clearCookie(SESSION_COOKIE, secure()) });

    const protectedRoute = /^(me|bookings)(\/|$)/.test(path);
    if (!protectedRoute) throw new ApiError(404, "NOT_FOUND", "Không tìm thấy đường dẫn này.");
    const user = requireUser(request, at);
    if (method !== "GET") limit(`uw:${user.id}`, 30, 60_000, at);
    const body = method === "GET" ? {} : await readJson(request);

    if (is("GET", /^me$/)) return reply(res, 200, me(user, at));
    if (is("GET", /^me\/player$/)) return reply(res, 200, portal(user, at));
    if (is("GET", /^me\/availability$/)) return reply(res, 200, { availability: portal(user, at).availability });
    if (is("PUT", /^me\/availability$/)) return reply(res, 200, await setHours(client, user, body, at));
    if (is("POST", /^me\/status$/)) return reply(res, 200, await setStatus(client, user, body, at));
    if (is("POST", /^bookings$/)) return reply(res, 201, await createFromWeb(client, user, body, at));
    if ((m = is("POST", /^bookings\/(\d{1,12})\/(pay-wallet|pay-link|cancel|rate)$/))) {
      const id = bookingIdOf(m[1]);
      const settings = getSettings();
      if (m[2] === "cancel") return reply(res, 200, await cancelFromWeb(client, user, id, at));
      if (m[2] === "rate") return reply(res, 200, await rateFromWeb(client, user, id, body, at));
      if (m[2] === "pay-wallet") {
        bucket("wallet", user.id, at);
        ownBooking(id, user.id);
        const paid = payFromWallet(id, user.id, at);
        await notifyPaid(client, paid.booking);
        return reply(res, 200, { booking: customerBooking(getBooking(id), at, settings, config.guildId), payment: { walletBalanceVnd: paid.balance, paid: true } });
      }
      bucket("wallet", user.id, at);
      const booking = ownBooking(id, user.id);
      if (booking.status !== "AWAITING_PAYMENT") fail("ILLEGAL_TRANSITION", { status: booking.status, action: "thanh toán" });
      if (at >= booking.created_at + settings.unpaidExpireMin * MINUTE) fail("TOO_LATE");
      return reply(res, 200, { booking: customerBooking(booking, at, settings, config.guildId), payment: { checkoutUrl: await linkFor(booking, at, settings), paid: false } });
    }
    throw new ApiError(404, "NOT_FOUND", "Không tìm thấy đường dẫn này.");
  } catch (error) {
    return failure(res, error);
  }
}
