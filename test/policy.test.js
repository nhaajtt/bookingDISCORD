import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { refundFor, tierFor, DEFAULT_TIERS } from "../src/domain/policy.js";
import { HOUR, MIN } from "./helpers.js";

const START = Date.UTC(2026, 9, 10, 12, 0);
const booking = (extra = {}) => ({ status: "CONFIRMED", price_vnd: 100_000, start_at: START, ...extra });

test("customer: more than 24 hours ahead refunds everything", () => {
  const r = refundFor(booking(), "customer", START - 48 * HOUR);
  assert.equal(r.refundVnd, 100_000);
  assert.equal(r.percent, 100);
  assert.equal(r.keptVnd, 0);
  assert.equal(r.strike, false);
});

test("customer: between 24 and 2 hours refunds half", () => {
  assert.equal(refundFor(booking(), "customer", START - 10 * HOUR).refundVnd, 50_000);
  assert.equal(refundFor(booking(), "customer", START - 24 * HOUR + MIN).refundVnd, 50_000);
});

test("customer: under 2 hours refunds nothing", () => {
  const r = refundFor(booking(), "customer", START - 119 * MIN);
  assert.equal(r.refundVnd, 0);
  assert.equal(r.keptVnd, 100_000);
  assert.equal(refundFor(booking(), "customer", START - 5 * MIN).refundVnd, 0);
});

test("boundaries favour the customer: exactly 24 hours is the top tier, exactly 2 hours the middle one", () => {
  assert.equal(refundFor(booking(), "customer", START - 24 * HOUR).percent, 100);
  assert.equal(refundFor(booking(), "customer", START - 2 * HOUR).percent, 50);
  assert.equal(refundFor(booking(), "customer", START - 2 * HOUR + 1).percent, 0);
});

test("after the start the last tier applies", () => {
  assert.equal(refundFor(booking(), "customer", START + 10 * MIN).percent, 0);
});

test("player cancelling always refunds in full and earns a strike, however late", () => {
  for (const now of [START - 100 * HOUR, START - HOUR, START - MIN, START + 5 * MIN]) {
    const r = refundFor(booking(), "player", now);
    assert.equal(r.refundVnd, 100_000);
    assert.equal(r.strike, true);
  }
});

test("staff and system cancellations refund in full without a strike", () => {
  for (const who of ["staff", "system"]) {
    const r = refundFor(booking(), who, START - MIN);
    assert.equal(r.refundVnd, 100_000);
    assert.equal(r.strike, false);
  }
});

test("a booking that was never paid refunds nothing and nobody is struck", () => {
  for (const who of ["customer", "player", "staff", "system"]) {
    const r = refundFor(booking({ status: "AWAITING_PAYMENT" }), who, START - 100 * HOUR);
    assert.equal(r.refundVnd, 0);
    assert.equal(r.strike, false);
  }
});

test("refund and kept part always add up to the price, for awkward prices too", () => {
  for (const price of [500, 1500, 10_500, 33_000, 150_500, 400_000]) {
    for (const hours of [100, 12, 1]) {
      const r = refundFor(booking({ price_vnd: price }), "customer", START - hours * HOUR);
      assert.equal(r.refundVnd + r.keptVnd, price);
      assert.ok(Number.isInteger(r.refundVnd) && r.refundVnd >= 0);
    }
  }
});

test("custom tiers from settings are honoured", () => {
  const tiers = [{ minHoursBefore: 48, refundPercent: 100 }, { minHoursBefore: 0, refundPercent: 20 }];
  assert.equal(refundFor(booking(), "customer", START - 50 * HOUR, tiers).percent, 100);
  assert.equal(refundFor(booking(), "customer", START - 5 * HOUR, tiers).percent, 20);
  assert.equal(tierFor(DEFAULT_TIERS, 30).refundPercent, 100);
});
