import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, confirmed, book, getDb } from "./helpers.js";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { config } from "../src/config.js";
import { fresh } from "./helpers.js";
import { createWebServer } from "../src/web/server.js";
import { esc, renderDashboard } from "../src/web/page.js";
import { dashboardToken, resetFailures, tokenValid } from "../src/web/auth.js";
import { verifyWebhookSignature } from "../src/pay/payos.js";
import { dashboardData } from "../src/domain/dashboard.js";
import { createBookingOrder, getOrder } from "../src/pay/orders.js";
import { getBooking, complete, start, cancel, actorFor, SYSTEM, noShow } from "../src/domain/bookings.js";
import { renderMetrics, jobFinished, count } from "../src/metrics.js";

const realFetch = globalThis.fetch;
let web;
let base;
let payosStatus = "PENDING";
let payosCalls;

beforeEach(async () => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  makeCustomer("c2");
  config.web.dashboardToken = "secret-token-1";
  config.web.metricsToken = null;
  resetFailures();
  payosCalls = 0;
  payosStatus = "PENDING";
  globalThis.fetch = (url, init) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, init);
    payosCalls += 1;
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ code: "00", data: { status: payosStatus, amount: 100_000, amountPaid: payosStatus === "PAID" ? 100_000 : 0 } }) });
  };
  const client = { notifyBooking: async () => {} };
  web = createWebServer({ client, now: () => NOW });
  const port = await web.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => {
  await web.close();
  globalThis.fetch = realFetch;
  config.web.dashboardToken = null;
  config.web.metricsToken = null;
});
after(() => {
  globalThis.fetch = realFetch;
});

const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });
const sign = (data, key = "checksum-key") =>
  createHmac("sha256", key).update(Object.keys(data).sort().map((k) => `${k}=${data[k] ?? ""}`).join("&")).digest("hex");
const post = (path, body, raw = false) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ? body : JSON.stringify(body) });

function finished(customerId, startAt, minutes = 60) {
  const b = confirmed({ customerId, playerId: "p1", startAt, durationMin: minutes, now: startAt - DAY });
  start(b.id, SYSTEM, startAt);
  complete(b.id, SYSTEM, startAt + minutes * MIN);
  return b;
}

// ---------------------------------------------------------------- basics

test("the root and the health check answer, and anything else is not found", async () => {
  assert.equal((await get("/")).status, 200);
  const health = await get("/healthz");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal((await get("/nothing")).status, 404);
  assert.equal((await get("/dashboard/extra/too/many")).status, 401, "a known route still needs the token");
  const headers = (await get("/")).headers;
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("cache-control"), "no-store");
});

// ---------------------------------------------------------------- the dashboard

test("the dashboard needs the token, by query or by header, and says nothing to anyone else", async () => {
  const denied = await get("/dashboard");
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes("Doanh thu"));
  assert.equal((await get("/dashboard?token=wrong-token")).status, 401);
  assert.equal((await get("/dashboard?token=short")).status, 401);
  const ok = await get("/dashboard?token=secret-token-1");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /text\/html/);
  const html = await ok.text();
  assert.match(html, /<title>Bảng điều khiển<\/title>/);
  assert.match(html, /Doanh thu/);
  assert.match(html, /robots/);
  assert.equal((await get("/dashboard", { authorization: "Bearer secret-token-1" })).status, 200);
});

test("eight wrong tries a minute lock an address out, even for the right token", async () => {
  for (let i = 0; i < 8; i += 1) assert.equal((await get("/dashboard?token=wrong-token-" + i)).status, 401);
  const locked = await get("/dashboard?token=secret-token-1");
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get("retry-after"), "60");
  resetFailures();
  assert.equal((await get("/dashboard?token=secret-token-1")).status, 200);
});

test("a token made by the owner works, a new one replaces it, and the environment token keeps working", async () => {
  config.web.dashboardToken = null;
  assert.equal((await get("/dashboard?token=secret-token-1")).status, 401);
  const token = dashboardToken();
  assert.equal(dashboardToken(), token, "asking again gives the same token");
  assert.ok(token.length >= 20);
  assert.equal((await get(`/dashboard?token=${token}`)).status, 200);
  const next = dashboardToken({ rotate: true });
  assert.notEqual(next, token);
  assert.equal((await get(`/dashboard?token=${token}`)).status, 401);
  assert.equal((await get(`/dashboard?token=${next}`)).status, 200);
  assert.equal(tokenValid(next), true);
  assert.equal(tokenValid(undefined), false);
  assert.equal(tokenValid(""), false);
});

test("the numbers are exports as JSON and CSV, behind the same token", async () => {
  finished("c1", NOW - 2 * DAY + 3 * HOUR);
  assert.equal((await get("/api/stats")).status, 401);
  const stats = await (await get("/api/stats?token=secret-token-1")).json();
  assert.equal(stats.totals.completed, 1);
  assert.equal(stats.days, 30);
  const ledger = await get("/ledger.csv?token=secret-token-1");
  assert.match(ledger.headers.get("content-type"), /text\/csv/);
  assert.match(ledger.headers.get("content-disposition"), /so-tien\.csv/);
  assert.match(await ledger.text(), /tra_player/);
  const bookings = await get("/bookings.csv?token=secret-token-1");
  assert.match(await bookings.text(), /id,khach,player/);
  assert.equal((await get("/ledger.csv")).status, 401);
  const wide = await get("/dashboard?token=secret-token-1&days=1000");
  assert.match(await wide.text(), /90 ngày gần nhất/, "the range is capped");
});

test("only GET reads the dashboard", async () => {
  const r = await fetch(`${base}/dashboard?token=secret-token-1`, { method: "POST" });
  assert.equal(r.status, 405);
});

// ---------------------------------------------------------------- the numbers

test("dashboard data adds up from bookings and the ledger", () => {
  finished("c1", NOW - 2 * DAY + 3 * HOUR); // 100.000 paid, 10.000 fee, 90.000 payout
  finished("c1", NOW - DAY + 3 * HOUR, 120); // 200.000
  finished("c2", NOW - 3 * DAY + 2 * HOUR);
  const cancelled = confirmed({ customerId: "c2", playerId: "p1", startAt: NOW + 3 * DAY, now: NOW - DAY });
  cancel(cancelled.id, actorFor(cancelled, "c2"), NOW - 12 * HOUR);
  const lost = confirmed({ customerId: "c2", playerId: "p1", startAt: NOW - 5 * HOUR, now: NOW - DAY });
  noShow(lost.id, "customer", SYSTEM, NOW - 4 * HOUR);
  const d = dashboardData(NOW);
  assert.equal(d.daily.length, 30);
  assert.equal(d.totals.completed, 3);
  assert.equal(d.totals.revenueVnd, 100_000 + 200_000 + 100_000 + 100_000, "three completed sessions and the kept no-show payment");
  assert.equal(d.totals.feeVnd, 10_000 + 20_000 + 10_000 + 10_000);
  assert.equal(d.totals.customers, 2);
  assert.equal(d.totals.returningCustomers, 1);
  assert.equal(d.totals.cancellationRate, 20, "one of five finished bookings");
  assert.equal(d.statuses.COMPLETED, 3);
  assert.equal(d.daily.at(-1).label, "05/10");
  assert.equal(d.daily.reduce((n, x) => n + x.completed, 0), 3);
  assert.equal(d.topPlayers[0].name, "Player p1");
  assert.equal(d.topCustomers[0].userId, "c1");
  assert.equal(d.ledger.payoutsOwed.count >= 3, true);
  assert.equal(dashboardData(NOW, { days: 7 }).daily.length, 7);
});

test("an empty server still draws the page", () => {
  const d = dashboardData(NOW);
  const html = renderDashboard(d);
  assert.match(html, /Chưa có dữ liệu/);
  assert.match(html, /chưa có/);
  assert.equal(d.totals.cancellationRate, null);
});

test("text from the data is escaped on the page", () => {
  assert.equal(esc(`<script>alert("x")</script> & 'y'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  const data = dashboardData(NOW);
  data.topPlayers = [{ name: "<img src=x onerror=alert(1)>", hours: 1, sessions: 1, average: null }];
  const html = renderDashboard(data, { title: "<b>x</b>" });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>x</b>"));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ---------------------------------------------------------------- the payOS webhook

test("the webhook signature is checked over every field of data, sorted by name", () => {
  const data = { orderCode: 123, amount: 100_000, description: "BOOK00123", code: "00", reference: null };
  assert.equal(verifyWebhookSignature(data, sign(data)), true);
  assert.equal(verifyWebhookSignature(data, sign(data).toUpperCase()), true);
  assert.equal(verifyWebhookSignature({ ...data, amount: 1 }, sign(data)), false);
  assert.equal(verifyWebhookSignature(data, sign(data, "other-key")), false);
  assert.equal(verifyWebhookSignature(data, "short"), false);
  assert.equal(verifyWebhookSignature(null, "x"), false);
  assert.equal(verifyWebhookSignature(data, undefined), false);
});

test("a signed webhook makes the bot look the order up at once, and the payment is confirmed from payOS's answer, not from the body", async () => {
  const b = book({ customerId: "c1", playerId: "p1", startAt: NOW + 3 * HOUR });
  const order = createBookingOrder(b.id, NOW);
  payosStatus = "PAID";
  const data = { orderCode: order.orderCode, amount: 100_000, description: order.description, code: "00" };
  const res = await post("/webhook/payos", { code: "00", desc: "success", success: true, data, signature: sign(data) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  for (let i = 0; i < 50 && getBooking(b.id).status !== "CONFIRMED"; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(getBooking(b.id).status, "CONFIRMED");
  assert.equal(getOrder(order.orderCode).status, "PAID");
  assert.equal(payosCalls >= 1, true);
});

test("a webhook claiming a payment that payOS does not confirm changes nothing", async () => {
  const b = book({ customerId: "c1", playerId: "p1", startAt: NOW + 3 * HOUR });
  const order = createBookingOrder(b.id, NOW);
  payosStatus = "PENDING";
  const data = { orderCode: order.orderCode, amount: 100_000, description: "x", code: "00" };
  assert.equal((await post("/webhook/payos", { data, signature: sign(data) })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(getBooking(b.id).status, "AWAITING_PAYMENT");
  assert.equal(getOrder(order.orderCode).status, "PENDING");
});

test("a webhook with a wrong or missing signature, bad JSON, a wrong method or a huge body is refused", async () => {
  const data = { orderCode: 1, amount: 1 };
  assert.equal((await post("/webhook/payos", { data, signature: sign(data, "wrong") })).status, 401);
  assert.equal((await post("/webhook/payos", { data })).status, 401);
  assert.equal((await post("/webhook/payos", { signature: "x" })).status, 401);
  assert.equal((await post("/webhook/payos", "{not json", true)).status, 400);
  assert.equal((await get("/webhook/payos")).status, 405);
  const huge = await post("/webhook/payos", JSON.stringify({ data: { pad: "x".repeat(70_000) }, signature: "x" }), true).catch(() => ({ status: 413 }));
  assert.equal(huge.status, 413);
  assert.equal(payosCalls, 0, "nothing reached payOS");
});

// ---------------------------------------------------------------- metrics

test("metrics are for localhost, or for the holder of METRICS_TOKEN, and carry the business numbers", async () => {
  book({ customerId: "c1", playerId: "p1", startAt: NOW + 3 * HOUR });
  jobFinished("payments", { ok: true, ms: 12, at: NOW });
  jobFinished("payments", { ok: false, ms: 20, at: NOW + 1 });
  count("custom_event", { kind: 'a"b' });
  const open = await get("/metrics");
  assert.equal(open.status, 200);
  const text = await open.text();
  assert.match(text, /# TYPE booking_bot_bookings gauge/);
  assert.match(text, /booking_bot_bookings\{status="AWAITING_PAYMENT"\} 1/);
  assert.match(text, /booking_bot_job_runs_total\{job="payments"\} 2/);
  assert.match(text, /booking_bot_job_failures_total\{job="payments"\} 1/);
  assert.match(text, /booking_bot_players\{status="active"\} 1/);
  assert.match(text, /booking_bot_wallet_liability_vnd 0/);
  assert.match(text, /booking_bot_custom_event_total\{kind="a\\"b"\} 1/);
  config.web.metricsToken = "metrics-secret";
  assert.equal((await get("/metrics")).status, 401);
  assert.equal((await get("/metrics", { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await get("/metrics", { authorization: "Bearer metrics-secret" })).status, 200);
});

test("renderMetrics writes valid exposition text", () => {
  const text = renderMetrics([{ name: "x_total", help: "h", labels: { a: "1" }, value: 3 }], NOW);
  assert.match(text, /^# HELP booking_bot_uptime_seconds/);
  assert.match(text, /x_total\{a="1"\} 3\n$/);
});
