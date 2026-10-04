import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, roundFee, validateRate, validateDuration, limitsFrom } from "../src/domain/pricing.js";
import { defaultSettings } from "../src/settings.js";

const limits = limitsFrom(defaultSettings());

test("an hour at 100,000 with a 10 percent fee", () => {
  assert.deepEqual(quote(100_000, 60, 10), { rateVnd: 100_000, durationMin: 60, priceVnd: 100_000, feeVnd: 10_000, playerShareVnd: 90_000 });
});

test("30 minute steps give exact half prices", () => {
  assert.equal(quote(100_000, 30, 10).priceVnd, 50_000);
  assert.equal(quote(21_000, 30, 10).priceVnd, 10_500);
  assert.equal(quote(100_000, 90, 10).priceVnd, 150_000);
  assert.equal(quote(100_000, 240, 10).priceVnd, 400_000);
});

test("the fee is rounded half up to a thousand and the player gets the rest", () => {
  assert.equal(quote(21_000, 30, 10).feeVnd, 1000, "1,050 rounds to 1,000");
  assert.equal(quote(25_000, 30, 10).feeVnd, 1000, "1,250 rounds to 1,000");
  assert.equal(quote(35_000, 30, 10).feeVnd, 2000, "1,750 rounds to 2,000");
  assert.equal(quote(30_000, 30, 10).feeVnd, 2000, "1,500 rounds half up to 2,000");
  assert.equal(roundFee(100_000, 0), 0);
  assert.equal(roundFee(100_000, 50), 50_000);
  assert.equal(roundFee(500, 10), 0);
});

test("fee never exceeds the price, even for a tiny price and a big percent", () => {
  assert.equal(roundFee(500, 100), 500);
  assert.equal(roundFee(1000, 100), 1000);
});

test("price = fee + player share, for every rate, duration and percent in range", () => {
  for (let rate = 20_000; rate <= 500_000; rate += 7000) {
    for (let min = 30; min <= 240; min += 30) {
      for (const pct of [0, 1, 5, 10, 12, 33, 50]) {
        const q = quote(rate, min, pct);
        assert.ok(Number.isInteger(q.priceVnd) && Number.isInteger(q.feeVnd) && Number.isInteger(q.playerShareVnd));
        assert.equal(q.feeVnd + q.playerShareVnd, q.priceVnd, `${rate} ${min} ${pct}`);
        assert.ok(q.feeVnd >= 0 && q.playerShareVnd >= 0);
        assert.equal(q.feeVnd % 1000, 0);
        assert.equal(q.priceVnd * 60, rate * min, "price is exactly rate x duration");
      }
    }
  }
});

test("rates must be whole thousands inside the owner's limits", () => {
  assert.throws(() => quote(100_500, 60, 10), (e) => e.code === "BAD_RATE");
  assert.throws(() => quote(0, 60, 10), (e) => e.code === "BAD_RATE");
  assert.throws(() => quote(-1000, 60, 10), (e) => e.code === "BAD_RATE");
  assert.throws(() => quote(100_000.5, 60, 10), (e) => e.code === "BAD_RATE");
  assert.throws(() => quote(19_000, 60, 10, limits), (e) => e.code === "BAD_RATE");
  assert.throws(() => quote(501_000, 60, 10, limits), (e) => e.code === "BAD_RATE");
  assert.equal(quote(20_000, 60, 10, limits).priceVnd, 20_000);
  assert.equal(quote(500_000, 60, 10, limits).priceVnd, 500_000);
  assert.equal(validateRate(50_000), 50_000);
});

test("durations are 30 minute steps from 30 minutes up to the maximum", () => {
  for (const bad of [0, 15, 45, 61, -30, 30.5, "60", NaN]) assert.throws(() => validateDuration(bad), (e) => e.code === "BAD_DURATION", String(bad));
  assert.throws(() => quote(100_000, 270, 10, limits), (e) => e.code === "BAD_DURATION");
  assert.equal(quote(100_000, 240, 10, limits).durationMin, 240);
  assert.equal(validateDuration(30), 30);
});

test("an invalid fee percent is refused", () => {
  assert.throws(() => roundFee(100_000, -1), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => roundFee(100_000, 101), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => roundFee(100_000, 10.5), (e) => e.code === "INVALID_INPUT");
});

test("errors carry a Vietnamese message and a stable code", () => {
  try {
    quote(100_500, 60, 10);
    assert.fail("should throw");
  } catch (e) {
    assert.equal(e.name, "DomainError");
    assert.match(e.message, /Giá theo giờ/);
  }
});
