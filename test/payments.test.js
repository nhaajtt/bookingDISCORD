import { fresh, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, NOW, HOUR, MIN, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { config } from "../src/config.js";
import { signPaymentRequest, createPaymentLink, getPayment, payosEnabled } from "../src/pay/payos.js";
import * as orders from "../src/pay/orders.js";
import { checkPayments } from "../src/jobs/payments.js";
import * as bk from "../src/domain/bookings.js";

const START = NOW + 3 * HOUR;

function stubFetch(handler) {
  globalThis.fetch = async (url, init = {}) => {
    const result = await handler(String(url), init);
    if (result instanceof Error) throw result;
    return { ok: (result.status ?? 200) < 400, status: result.status ?? 200, json: async () => result.body };
  };
}

const paidAnswer = (amount) => ({ body: { code: "00", data: { status: "PAID", amount, amountPaid: amount } } });
const pendingAnswer = (amount) => ({ body: { code: "00", data: { status: "PENDING", amount, amountPaid: 0 } } });

function fakeClient() {
  const events = [];
  return { events, notifyBooking: async (e) => events.push(e) };
}

function silently(fn) {
  const original = console.error;
  console.error = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.error = original;
  });
}

beforeEach(() => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  globalThis.fetch = undefined;
});

// ---------------------------------------------------------------- payOS client

test("the request signature is HMAC-SHA256 over the five fields sorted by name", () => {
  const request = { amount: 260000, cancelUrl: "https://x.test/huy", description: "BOOK00042", orderCode: 1760000000042, returnUrl: "https://x.test/ok" };
  const expected = createHmac("sha256", "checksum-key")
    .update("amount=260000&cancelUrl=https://x.test/huy&description=BOOK00042&orderCode=1760000000042&returnUrl=https://x.test/ok")
    .digest("hex");
  assert.equal(signPaymentRequest(request), expected);
  assert.notEqual(signPaymentRequest(request, "another-key"), expected);
});

test("createPaymentLink sends the keys in headers and a signed body with an expiry, and returns the checkout link", async () => {
  let seen;
  stubFetch((url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { body: { code: "00", desc: "success", data: { checkoutUrl: "https://pay.payos.vn/web/abc", paymentLinkId: "abc" } } };
  });
  const link = await createPaymentLink({ orderCode: 123, amount: 100_000, description: "BOOK00123", returnUrl: "https://x.test/ok", cancelUrl: "https://x.test/huy", expiredAt: 1_790_000_000 });
  assert.equal(link.checkoutUrl, "https://pay.payos.vn/web/abc");
  assert.equal(seen.url, "https://api-merchant.payos.vn/v2/payment-requests");
  assert.equal(seen.init.headers["x-client-id"], "client-id");
  assert.equal(seen.init.headers["x-api-key"], "api-key");
  assert.equal(seen.body.expiredAt, 1_790_000_000);
  assert.equal(seen.body.signature, signPaymentRequest(seen.body), "the expiry is not part of the signed fields");
});

test("a payOS error or a missing link is an error, never success", async () => {
  const args = { orderCode: 1, amount: 2000, description: "T", returnUrl: "a", cancelUrl: "b" };
  stubFetch(() => ({ status: 401, body: { code: "401", desc: "bad key" } }));
  await assert.rejects(createPaymentLink(args), (e) => e.kind === "api");
  stubFetch(() => ({ body: { code: "00", data: {} } }));
  await assert.rejects(createPaymentLink(args), (e) => e.kind === "bad");
  stubFetch(() => new Error("network down"));
  await assert.rejects(createPaymentLink(args), (e) => e.kind === "api");
  assert.ok(payosEnabled());
});

test("without all three keys payOS is off and calls are refused", async () => {
  const saved = config.payos.apiKey;
  config.payos.apiKey = null;
  try {
    assert.equal(payosEnabled(), false);
    await assert.rejects(getPayment(1), (e) => e.kind === "off");
    assert.deepEqual(await checkPayments(fakeClient(), NOW), { checked: 0, paid: 0, late: 0 });
  } finally {
    config.payos.apiKey = saved;
  }
});

const pick = ({ status, paid, closed }) => ({ status, paid, closed });

test("getPayment understands paid, pending and closed answers", async () => {
  const answer = (data) => stubFetch(() => ({ body: { code: "00", data } }));
  answer({ status: "PAID", amount: 2000, amountPaid: 2000 });
  assert.deepEqual(pick(await getPayment(1)), { status: "PAID", paid: true, closed: false });
  answer({ status: "PENDING", amount: 2000, amountPaid: 0 });
  assert.deepEqual(pick(await getPayment(1)), { status: "PENDING", paid: false, closed: false });
  answer({ status: "PROCESSING", amount: 2000, amountPaid: 2000 });
  assert.equal((await getPayment(1)).paid, true);
  answer({ status: "PENDING", amount: 2000, amountPaid: 1000 });
  const half = await getPayment(1);
  assert.equal(half.paid, false, "half paid is not paid");
  assert.deepEqual([half.amount, half.amountPaid], [2000, 1000], "the partial amount is reported");
  answer({ status: "CANCELLED", amount: 2000, amountPaid: 0 });
  assert.deepEqual(pick(await getPayment(1)), { status: "CANCELLED", paid: false, closed: true });
});

// ---------------------------------------------------------------- orders

test("order codes are numbers and descriptions stay inside nine characters", () => {
  const code = orders.newOrderCode(NOW, () => 0.5);
  assert.ok(Number.isSafeInteger(code) && code > 0);
  assert.ok(orders.describeOrder(code).length <= 9);
  assert.equal(orders.describeOrder(7), "BOOK00007");
  assert.equal(orders.describeOrder(1_760_000_123_456), "BOOK23456");
  for (const n of [0, 1, 99999, 100000, Number.MAX_SAFE_INTEGER]) assert.ok(orders.describeOrder(n).length <= 9);
});

test("an order takes its amount from the booking and links back to it", () => {
  const b = book({ startAt: START, durationMin: 90 });
  const o = orders.createBookingOrder(b.id, NOW, () => 0.25);
  assert.equal(o.amount, 150_000);
  assert.equal(o.amount, b.price_vnd);
  assert.equal(o.description, orders.describeOrder(o.orderCode));
  assert.equal(o.expiredAt, Math.floor((NOW + 30 * MIN) / 1000));
  const row = orders.getOrder(o.orderCode);
  assert.deepEqual([row.booking_id, row.user_id, row.amount, row.status], [b.id, "c1", 150_000, "PENDING"]);
  assert.equal(bk.getBooking(b.id).order_code, o.orderCode);
  orders.setCheckoutUrl(o.orderCode, "https://pay.payos.vn/web/x");
  assert.equal(orders.getOrder(o.orderCode).checkout_url, "https://pay.payos.vn/web/x");
  assert.equal(orders.pendingOrderFor(b.id).order_code, o.orderCode);
});

test("only one pending order per booking, and only for unpaid bookings", () => {
  const b = book({ startAt: START });
  orders.createBookingOrder(b.id, NOW);
  assert.throws(() => orders.createBookingOrder(b.id, NOW + MIN), (e) => e.code === "ORDER_EXISTS");
  const paid = confirmed({ startAt: START + 3 * HOUR });
  assert.throws(() => orders.createBookingOrder(paid.id, NOW), (e) => e.code === "ILLEGAL_TRANSITION");
  assert.throws(() => orders.createBookingOrder(999, NOW), (e) => e.code === "NOT_FOUND");
});

test("a new order is allowed once the old one is closed, and colliding codes are moved along", () => {
  const b = book({ startAt: START });
  const first = orders.createBookingOrder(b.id, NOW, () => 0);
  orders.closeOrder(first.orderCode, "FAILED");
  const second = orders.createBookingOrder(b.id, NOW, () => 0);
  assert.equal(second.orderCode, first.orderCode + 1);
  assert.equal(bk.getBooking(b.id).order_code, second.orderCode);
});

test("closeOrder only changes pending orders", () => {
  const b = book({ startAt: START });
  const o = orders.createBookingOrder(b.id, NOW);
  orders.closeOrder(o.orderCode, "CANCELLED");
  orders.closeOrder(o.orderCode, "FAILED");
  assert.equal(orders.getOrder(o.orderCode).status, "CANCELLED");
  assert.equal(orders.recentOrders(5).length, 1);
});

test("settleOrder flips PENDING to PAID once and hands the order to the first caller only", () => {
  const b = book({ startAt: START });
  const o = orders.createBookingOrder(b.id, NOW);
  assert.equal(orders.settleOrder(o.orderCode, NOW + MIN).status, "PAID");
  assert.equal(orders.settleOrder(o.orderCode, NOW + 2 * MIN), null);
  assert.equal(orders.settleOrder(12345, NOW), null);
  assert.equal(orders.getOrder(o.orderCode).paid_at, NOW + MIN);
});

test("orders are polled for 35 minutes and then expire", () => {
  const b = book({ startAt: START });
  const o = orders.createBookingOrder(b.id, NOW);
  assert.equal(orders.pendingOrders(NOW + 34 * MIN).length, 1);
  assert.equal(orders.pendingOrders(NOW + 35 * MIN).length, 0);
  assert.equal(orders.expireStaleOrders(NOW + 35 * MIN), 1);
  assert.equal(orders.getOrder(o.orderCode).status, "EXPIRED");
  assert.equal(orders.expireStaleOrders(NOW + 36 * MIN), 0);
});

// ---------------------------------------------------------------- checkPayments

function pendingBooking(extra = {}) {
  const b = book({ startAt: START, ...extra });
  const o = orders.createBookingOrder(b.id, NOW);
  return { b, o };
}

test("a paid order confirms the booking once, however many times it is polled", async () => {
  const { b, o } = pendingBooking();
  stubFetch(() => paidAnswer(100_000));
  const client = fakeClient();
  assert.deepEqual(await checkPayments(client, NOW + MIN), { checked: 1, paid: 1, late: 0 });
  const confirmedBooking = bk.getBooking(b.id);
  assert.equal(confirmedBooking.status, "CONFIRMED");
  assert.equal(confirmedBooking.paid_at, NOW + MIN);
  assert.deepEqual(await checkPayments(client, NOW + 2 * MIN), { checked: 0, paid: 0, late: 0 }, "a paid order is no longer polled");
  assert.equal(client.events.length, 1);
  assert.equal(client.events[0].kind, "paid");
  assert.equal(client.events[0].booking.id, b.id);
  assert.equal(client.events[0].order.order_code, o.orderCode);
  assert.equal(orders.getOrder(o.orderCode).status, "PAID");
  assert.equal(ledgerRows(b.id).length, 0, "paying creates no ledger rows yet, money rows come with the outcome");
});

test("two polls running at the same moment still settle the order once", async () => {
  const { b } = pendingBooking();
  stubFetch(() => paidAnswer(100_000));
  const client = fakeClient();
  const [one, two] = await Promise.all([checkPayments(client, NOW + MIN), checkPayments(client, NOW + MIN)]);
  assert.equal(one.paid + two.paid, 1);
  assert.equal(client.events.length, 1);
  assert.equal(bk.getBooking(b.id).status, "CONFIRMED");
});

test("an unpaid order stays pending, a cancelled one is closed, a stale one expires", async () => {
  const { o } = pendingBooking();
  stubFetch(() => pendingAnswer(100_000));
  assert.deepEqual(await checkPayments(fakeClient(), NOW + MIN), { checked: 1, paid: 0, late: 0 });
  assert.equal(orders.getOrder(o.orderCode).status, "PENDING");
  stubFetch(() => ({ body: { code: "00", data: { status: "CANCELLED", amount: 100_000, amountPaid: 0 } } }));
  await checkPayments(fakeClient(), NOW + 2 * MIN);
  assert.equal(orders.getOrder(o.orderCode).status, "CANCELLED");
  const { o: second } = (makeCustomer("c2"), pendingBooking({ customerId: "c2", startAt: START + 3 * HOUR }));
  stubFetch(() => pendingAnswer(100_000));
  await checkPayments(fakeClient(), NOW + 36 * MIN);
  assert.equal(orders.getOrder(second.orderCode).status, "EXPIRED");
});

test("money that arrives after the booking expired becomes a refund and the booking stays expired", async () => {
  const { b, o } = pendingBooking();
  bk.expireUnpaid(b.id, NOW + 30 * MIN);
  stubFetch(() => paidAnswer(100_000));
  const client = fakeClient();
  assert.deepEqual(await checkPayments(client, NOW + 31 * MIN), { checked: 1, paid: 0, late: 1 });
  assert.equal(bk.getBooking(b.id).status, "EXPIRED");
  assert.deepEqual(ledgerRows(b.id).map((r) => [r.kind, r.party_user_id, r.amount_vnd, r.status]), [["REFUND", "c1", 100_000, "OWED"]]);
  assert.equal(client.events[0].kind, "late_refund");
  await checkPayments(client, NOW + 32 * MIN);
  assert.equal(ledgerRows(b.id).length, 1);
  assert.equal(orders.getOrder(o.orderCode).status, "PAID");
});

test("money for a booking cancelled before it was paid is refunded too", async () => {
  const { b } = pendingBooking();
  bk.cancel(b.id, { role: "customer", userId: "c1" }, NOW + MIN);
  stubFetch(() => paidAnswer(100_000));
  await checkPayments(fakeClient(), NOW + 2 * MIN);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
  assert.equal(ledgerRows(b.id)[0].kind, "REFUND");
});

test("if confirming the booking fails, the order flip is undone and the order is tried again later", async () => {
  const { b, o } = pendingBooking();
  // Simulates a bug elsewhere: the booking is already confirmed, with no payment on record, while its order still waits
  getDb().prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?").run(b.id);
  stubFetch(() => paidAnswer(100_000));
  await silently(() => checkPayments(fakeClient(), NOW + MIN));
  assert.equal(orders.getOrder(o.orderCode).status, "PENDING", "not marked paid without the booking knowing");
  assert.equal(orders.getOrder(o.orderCode).paid_at, null);
});

test("a second payment for a booking that is already paid is recorded and reported, never silently kept", async () => {
  const { b, o } = pendingBooking();
  getDb().prepare("UPDATE bookings SET status = 'CONFIRMED', paid_at = ? WHERE id = ?").run(NOW, b.id);
  stubFetch(() => paidAnswer(100_000));
  const client = fakeClient();
  assert.deepEqual(await checkPayments(client, NOW + MIN), { checked: 1, paid: 1, late: 0 });
  assert.equal(orders.getOrder(o.orderCode).status, "PAID", "the order is closed so it is not polled again");
  assert.deepEqual(client.events.map((e) => e.kind), ["duplicate"]);
  assert.equal(ledgerRows(b.id).length, 0, "no ledger row is invented: the owner refunds it by hand");
  assert.deepEqual(await checkPayments(client, NOW + 2 * MIN), { checked: 0, paid: 0, late: 0 });
});

test("one order that cannot be read does not stop the others", async () => {
  makeCustomer("c2");
  const a = pendingBooking();
  const c = pendingBooking({ customerId: "c2", startAt: START + 3 * HOUR });
  stubFetch((url) => (url.endsWith(String(a.o.orderCode)) ? new Error("boom") : paidAnswer(100_000)));
  const result = await silently(() => checkPayments(fakeClient(), NOW + MIN));
  assert.deepEqual(result, { checked: 2, paid: 1, late: 0 });
  assert.equal(bk.getBooking(a.b.id).status, "AWAITING_PAYMENT");
  assert.equal(bk.getBooking(c.b.id).status, "CONFIRMED");
});

test("a failing announcement does not undo a payment", async () => {
  const { b } = pendingBooking();
  stubFetch(() => paidAnswer(100_000));
  const client = { notifyBooking: async () => { throw new Error("discord down"); } };
  const result = await silently(() => checkPayments(client, NOW + MIN));
  assert.equal(result.paid, 1);
  assert.equal(bk.getBooking(b.id).status, "CONFIRMED");
});

test("a client without notifyBooking is fine", async () => {
  const { b } = pendingBooking();
  stubFetch(() => paidAnswer(100_000));
  assert.equal((await checkPayments({}, NOW + MIN)).paid, 1);
  assert.equal(bk.getBooking(b.id).status, "CONFIRMED");
  assert.equal((await checkPayments(undefined, NOW + MIN)).paid, 0);
});

test("the job is registered with a name and an interval", async () => {
  const job = (await import("../src/jobs/payments.js")).default;
  assert.equal(job.name, "payments");
  assert.equal(job.everyMs, 30_000);
  assert.equal(typeof job.run, "function");
});

test("end to end: order, payment, session, completion and the owner's ledger", async () => {
  const { b } = pendingBooking();
  stubFetch(() => paidAnswer(100_000));
  await checkPayments(fakeClient(), NOW + MIN);
  bk.start(b.id, bk.SYSTEM, START);
  bk.complete(b.id, bk.SYSTEM, START + HOUR);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
});
