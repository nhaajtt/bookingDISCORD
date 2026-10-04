import { NOW, HOUR, MIN, makePlayer, makeCustomer, book, confirmed, ledgerRows, getDb, getSettings, saveSettings } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, lastPayload } from "./discord-fakes.js";
import { config } from "../src/config.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { checkPayments } from "../src/jobs/payments.js";
import { runRefunds, planRefund } from "../src/jobs/refunds.js";
import { formEncode, createCheckout, getCheckout, expireCheckout, refundCheckout, stripeEnabled, MIN_SESSION_MIN } from "../src/pay/stripe.js";
import { PROVIDERS, defaultProvider, enabledProviders, anyProviderEnabled } from "../src/pay/gateway.js";
import { PayError } from "../src/pay/payos.js";
import { getBooking, cancel, actorFor, start, complete, SYSTEM } from "../src/domain/bookings.js";
import { pendingRefunds } from "../src/domain/ledger.js";
import { checkoutBooking, checkoutExtension } from "../src/pay/checkout.js";
import { getOrder } from "../src/pay/orders.js";

let env;
let stripe;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player, { rateVnd: 100_000 });
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
  stripe = { calls: [], sessions: {}, refundFails: false, counter: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const call = { url: u, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null };
    stripe.calls.push(call);
    const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
    if (u.includes("api.stripe.com")) {
      if (u.endsWith("/v1/checkout/sessions") && call.method === "POST") {
        const id = `cs_${(stripe.counter += 1)}`;
        stripe.sessions[id] = { id, status: "open", payment_status: "unpaid", amount_total: Number(call.body.line_items?.[0] ?? call.body["line_items[0][price_data][unit_amount]"]), payment_intent: `pi_${id}` };
        return reply(200, { id, url: `https://checkout.stripe.test/${id}` });
      }
      const m = /\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(u);
      if (m && m[2] && call.method === "POST") {
        stripe.sessions[m[1]].status = "expired";
        return reply(200, stripe.sessions[m[1]]);
      }
      if (m && call.method === "GET") return stripe.sessions[m[1]] ? reply(200, stripe.sessions[m[1]]) : reply(404, { error: { code: "resource_missing", message: "No such session" } });
      if (u.endsWith("/v1/refunds") && call.method === "POST") {
        if (stripe.refundFails) return reply(402, { error: { code: "charge_already_refunded", message: "x" } });
        return reply(200, { id: `re_${stripe.calls.length}`, status: "succeeded" });
      }
    }
    if (u.includes("payos.vn")) {
      return reply(200, String(u).endsWith("/v2/payment-requests") ? { code: "00", data: { checkoutUrl: "https://pay.payos.vn/web/abc", paymentLinkId: "abc" } } : { code: "00", data: { status: "PENDING", amount: 100_000, amountPaid: 0 } });
    }
    return reply(404, {});
  };
  config.stripe.secretKey = "sk_test_123";
  config.paymentProvider = "stripe";
});
afterEach(() => {
  globalThis.fetch = undefined;
  config.stripe.secretKey = null;
  config.paymentProvider = null;
  setClock(() => NOW);
});

const form = { game: "liên quân", when: "05/10 19:00", duration: "1" };
const pay = (id, status = "complete", payment = "paid") => Object.assign(stripe.sessions[id], { status, payment_status: payment });
const START = NOW + 30 * HOUR;

// ---------------------------------------------------------------- the Stripe client

test("form encoding writes nested objects and arrays with bracket names and escapes values", () => {
  assert.deepEqual(formEncode({ a: 1, b: { c: "x y", d: [{ e: 2 }] }, skip: undefined, nul: null }), ["a=1", "b%5Bc%5D=x%20y", "b%5Bd%5D%5B0%5D%5Be%5D=2"]);
});

test("a checkout session is made with the amount in dong, an expiry Stripe accepts, an idempotency key and the bearer key", async () => {
  const link = await createCheckout({ orderCode: 77, amount: 100_000, description: "BOOK00077", returnUrl: "https://x.test/ok", cancelUrl: "https://x.test/no", now: 1_800_000_000_000 });
  assert.deepEqual(link, { checkoutUrl: "https://checkout.stripe.test/cs_1", externalId: "cs_1" });
  const call = stripe.calls[0];
  assert.equal(call.headers.authorization, "Bearer sk_test_123");
  assert.equal(call.headers["idempotency-key"], "order-77");
  assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(
    [call.body.mode, call.body.client_reference_id, call.body["line_items[0][price_data][currency]"], call.body["line_items[0][price_data][unit_amount]"], call.body["line_items[0][quantity]"], call.body["line_items[0][price_data][product_data][name]"]],
    ["payment", "77", "vnd", "100000", "1", "BOOK00077"],
  );
  assert.equal(Number(call.body.expires_at), 1_800_000_000 + MIN_SESSION_MIN * 60);
  assert.equal(call.body.success_url, "https://x.test/ok");
});

test("a session is read as paid, open or expired, and errors never look like success", async () => {
  await createCheckout({ orderCode: 1, amount: 5000, description: "x", returnUrl: "a", cancelUrl: "b" });
  assert.deepEqual(await getCheckout("cs_1"), { status: "OPEN", paid: false, closed: false, amount: 5000, amountPaid: 0 });
  stripe.sessions.cs_1.amount_total = 5000;
  pay("cs_1");
  assert.deepEqual(await getCheckout("cs_1"), { status: "COMPLETE", paid: true, closed: false, amount: 5000, amountPaid: 5000 });
  stripe.sessions.cs_1.status = "expired";
  stripe.sessions.cs_1.payment_status = "unpaid";
  assert.equal((await getCheckout("cs_1")).closed, true);
  await assert.rejects(getCheckout("cs_404"), (e) => e instanceof PayError && e.kind === "api" && /resource_missing/.test(e.message));
  assert.equal(await expireCheckout("cs_1"), true);
  assert.equal(await expireCheckout("cs_404"), false);
  const refund = await refundCheckout("cs_1", 2000, "key-1");
  assert.equal(refund.status, "succeeded");
  const sent = stripe.calls.at(-1);
  assert.deepEqual([sent.body.payment_intent, sent.body.amount, sent.headers["idempotency-key"]], ["pi_cs_1", "2000", "key-1"]);
});

test("without a key Stripe is off and its calls are refused", async () => {
  config.stripe.secretKey = null;
  assert.equal(stripeEnabled(), false);
  await assert.rejects(getCheckout("cs_1"), (e) => e.kind === "off");
});

test("the gateway used for a new payment is the configured one if it is on, otherwise the first that is", () => {
  assert.deepEqual(enabledProviders(), ["payos", "stripe"]);
  assert.equal(defaultProvider(), "stripe");
  config.paymentProvider = "payos";
  assert.equal(defaultProvider(), "payos");
  config.paymentProvider = null;
  assert.equal(defaultProvider(), "payos");
  config.stripe.secretKey = null;
  config.paymentProvider = "stripe";
  assert.equal(defaultProvider(), "payos", "a gateway that is switched off is not chosen");
  const saved = config.payos.apiKey;
  config.payos.apiKey = null;
  assert.equal(defaultProvider(), null);
  assert.equal(anyProviderEnabled(), false);
  config.payos.apiKey = saved;
  assert.equal(PROVIDERS.payos.canRefund, false);
  assert.equal(PROVIDERS.stripe.canRefund, true);
});

// ---------------------------------------------------------------- a booking paid through Stripe

test("a booking is paid through the configured gateway: link, payment detection, confirmation", async () => {
  const i = await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  assert.equal(lastPayload(i).components[0].toJSON().components[0].url, "https://checkout.stripe.test/cs_1");
  const order = getDb().prepare("SELECT * FROM orders").get();
  assert.deepEqual([order.provider, order.external_id, order.kind, order.amount], ["stripe", "cs_1", "BOOKING", 100_000]);
  assert.equal(stripe.calls.some((c) => c.url.includes("payos")), false, "payOS was not used");

  assert.deepEqual(await checkPayments(env.client, NOW + MIN), { checked: 1, paid: 0, late: 0 });
  pay("cs_1");
  assert.deepEqual(await checkPayments(env.client, NOW + 2 * MIN), { checked: 1, paid: 1, late: 0 });
  assert.equal(getBooking(1).status, "CONFIRMED");
  assert.match(dms(env.client, IDS.cust).at(-1), /Đã nhận thanh toán\. Lịch #1/);
});

test("payments from both gateways are polled side by side", async () => {
  const a = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  makeCustomer(IDS.cust2);
  const b = book({ customerId: IDS.cust2, playerId: IDS.player, startAt: START + 3 * HOUR });
  await checkoutBooking(a, NOW, "stripe");
  await checkoutBooking(b, NOW, "payos");
  pay("cs_1");
  const result = await checkPayments(env.client, NOW + MIN);
  assert.equal(result.checked, 2);
  assert.equal(result.paid, 1);
  assert.equal(getBooking(a.id).status, "CONFIRMED");
  assert.equal(getBooking(b.id).status, "AWAITING_PAYMENT");
});

test("when the gateway cannot make a link the booking is cancelled again and the order is closed as failed", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "down" } }) });
  const quiet = console.error;
  console.error = () => {};
  try {
    const i = await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
    assert.match(textOf(i), /đang bận/);
  } finally {
    console.error = quiet;
    globalThis.fetch = original;
  }
  assert.equal(getBooking(1).status, "CANCELLED");
  assert.equal(getDb().prepare("SELECT status FROM orders").get().status, "FAILED");
});

// ---------------------------------------------------------------- automatic refunds

async function paidByStripe(startAt = START, extra = {}) {
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt, ...extra });
  await checkoutBooking(b, NOW, "stripe");
  pay(`cs_${stripe.counter}`);
  await checkPayments(env.client, NOW + MIN);
  assert.equal(getBooking(b.id).status, "CONFIRMED");
  return b;
}

test("a refund of a Stripe payment is sent back automatically, once, and the ledger and both people are told", async () => {
  const b = await paidByStripe();
  cancel(b.id, actorFor(getBooking(b.id), IDS.cust), NOW + 5 * MIN);
  assert.equal(pendingRefunds().length, 1);
  const before = stripe.calls.length;
  assert.deepEqual(await runRefunds(env.client, NOW + 10 * MIN), { refunded: 1 });
  const refundCall = stripe.calls.slice(before).find((c) => c.url.endsWith("/v1/refunds"));
  assert.deepEqual([refundCall.body.payment_intent, refundCall.body.amount, refundCall.headers["idempotency-key"]], ["pi_cs_1", "100000", "ledger-1-" + getDb().prepare("SELECT order_code FROM orders").get().order_code]);
  const row = ledgerRows(b.id).find((r) => r.kind === "REFUND");
  assert.deepEqual([row.status, row.paid_by, row.note], ["PAID", "auto", row.note]);
  assert.match(row.note ?? "", /Stripe|hoàn/);
  assert.equal(pendingRefunds().length, 0);
  assert.match(dms(env.client, IDS.cust).at(-1), /Đã hoàn 100\.000 đ về thẻ/);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Hoàn tự động 100\.000 đ/);
  const calls = stripe.calls.length;
  assert.deepEqual(await runRefunds(env.client, NOW + 20 * MIN), { refunded: 0 });
  assert.equal(stripe.calls.length, calls, "nothing is sent twice");
});

test("a refund that Stripe refuses stays in the owner's queue and is tried again with the same key", async () => {
  const b = await paidByStripe();
  cancel(b.id, actorFor(getBooking(b.id), IDS.cust), NOW + 5 * MIN);
  stripe.refundFails = true;
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await runRefunds(env.client, NOW + 10 * MIN), { refunded: 0 });
  } finally {
    console.error = quiet;
  }
  assert.equal(pendingRefunds().length, 1);
  stripe.refundFails = false;
  assert.deepEqual(await runRefunds(env.client, NOW + 15 * MIN), { refunded: 1 });
  const keys = stripe.calls.filter((c) => c.url.endsWith("/v1/refunds")).map((c) => c.headers["idempotency-key"]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "a retry can never refund twice");
});

test("a booking paid through payOS is never refunded automatically, it stays for the owner", async () => {
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  await checkoutBooking(b, NOW, "payos");
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: "00", data: { status: "PAID", amount: 100_000, amountPaid: 100_000 } }) });
  await checkPayments(env.client, NOW + MIN);
  cancel(b.id, actorFor(getBooking(b.id), IDS.cust), NOW + 5 * MIN);
  const row = pendingRefunds()[0];
  assert.equal(planRefund(row), null);
  assert.deepEqual(await runRefunds(env.client, NOW + 10 * MIN), { refunded: 0 });
  assert.equal(pendingRefunds().length, 1);
});

test("a refund that covers an extension is split over the orders that paid for it", async () => {
  const b = await paidByStripe(NOW + 2 * HOUR);
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  const t = NOW + 2 * HOUR + 30 * MIN;
  await checkoutExtension(getBooking(b.id), 60, 100_000, 10_000, t, "stripe");
  pay(`cs_${stripe.counter}`);
  await checkPayments(env.client, t + MIN);
  assert.equal(getBooking(b.id).price_vnd, 200_000);
  cancel(b.id, { role: "staff", userId: "s" }, t + 2 * MIN);
  const plan = planRefund(pendingRefunds()[0]);
  assert.deepEqual(plan.map((p) => p.amount), [100_000, 100_000]);
  const before = stripe.calls.length;
  assert.deepEqual(await runRefunds(env.client, t + 5 * MIN), { refunded: 1 });
  const sent = stripe.calls.slice(before).filter((c) => c.url.endsWith("/v1/refunds"));
  assert.deepEqual(sent.map((c) => c.body.amount), ["100000", "100000"]);
  assert.deepEqual(sent.map((c) => c.body.payment_intent).sort(), ["pi_cs_1", "pi_cs_2"]);
});

test("money that arrives late through Stripe is refunded without the owner doing anything", async () => {
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  await checkoutBooking(b, NOW, "stripe");
  const { expireUnpaid } = await import("../src/domain/bookings.js");
  expireUnpaid(b.id, NOW + 31 * MIN);
  pay("cs_1");
  const result = await checkPayments(env.client, NOW + 32 * MIN);
  assert.equal(result.late, 1);
  assert.equal(pendingRefunds().length, 1);
  assert.deepEqual(await runRefunds(env.client, NOW + 40 * MIN), { refunded: 1 });
  assert.equal(pendingRefunds().length, 0);
});

test("the refunds job is registered and the app settings are untouched by Stripe", () => {
  assert.ok(getSettings());
  saveSettings({ ...getSettings() });
  assert.equal(typeof runRefunds, "function");
  assert.equal(getOrder(1), null);
  assert.ok(confirmed);
  assert.ok(complete);
});
