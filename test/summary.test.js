import { fresh, makePlayer, makeCustomer, confirmed, book, NOW, HOUR, MIN, DAY, vn } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as bk from "../src/domain/bookings.js";
import { ownerSummary, playerEarnings } from "../src/domain/summary.js";
import { markPaid, pendingPayouts } from "../src/domain/ledger.js";
import { attest } from "../src/domain/attestations.js";
import { applyAsPlayer } from "../src/domain/players.js";
import { recordRating } from "../src/domain/ratings.js";

const { SYSTEM } = bk;
const TODAY_EVENING = vn(2026, 10, 5, 19, 0);

beforeEach(() => {
  fresh();
  makePlayer("p1");
  makePlayer("p2");
  makeCustomer("c1");
  makeCustomer("c2");
});

function finish(b) {
  bk.start(b.id, SYSTEM, b.start_at);
  bk.complete(b.id, SYSTEM, b.start_at + b.duration_min * MIN);
}

test("an empty server gives an empty, well-formed summary", () => {
  const s = ownerSummary(NOW);
  assert.equal(s.today.count, 0);
  assert.equal(s.next7Days.count, 0);
  assert.deepEqual(s.period, { since: vn(2026, 10, 5) - 6 * DAY, until: NOW, revenueVnd: 0, feeVnd: 0, playerShareVnd: 0, refundedVnd: 0, bookings: 0 });
  assert.deepEqual(s.payouts, { payableCount: 0, payableVnd: 0, heldCount: 0, heldVnd: 0 });
  assert.deepEqual(s.refunds, { count: 0, vnd: 0 });
  assert.deepEqual(s.pendingApplications, []);
  assert.deepEqual(s.openDisputes, []);
});

test("today and the next seven days are split at local midnight", () => {
  const today = confirmed({ startAt: TODAY_EVENING });
  const tomorrow = confirmed({ customerId: "c2", startAt: vn(2026, 10, 6, 9, 0) });
  const day7 = confirmed({ customerId: "c1", startAt: vn(2026, 10, 12, 23, 0), playerId: "p2" });
  const day8 = book({ customerId: "c2", startAt: vn(2026, 10, 13, 0, 0), playerId: "p2" });
  const s = ownerSummary(NOW);
  assert.deepEqual(s.today.bookings.map((b) => b.id), [today.id]);
  assert.deepEqual(s.next7Days.bookings.map((b) => b.id), [tomorrow.id, day7.id]);
  assert.equal(s.today.expectedVnd, 100_000);
  assert.equal(s.next7Days.expectedVnd, 200_000);
  assert.ok(day8);
});

test("a booking at 00:30 local belongs to the new day even though it is the previous day in UTC", () => {
  const late = confirmed({ startAt: vn(2026, 10, 6, 0, 30) });
  const s = ownerSummary(NOW);
  assert.equal(s.today.count, 0);
  assert.deepEqual(s.next7Days.bookings.map((b) => b.id), [late.id]);
  const later = ownerSummary(vn(2026, 10, 6, 0, 10));
  assert.deepEqual(later.today.bookings.map((b) => b.id), [late.id]);
});

test("finished and cancelled bookings are not listed as upcoming", () => {
  const a = confirmed({ startAt: TODAY_EVENING });
  bk.cancel(a.id, { role: "customer", userId: "c1" }, NOW);
  assert.equal(ownerSummary(NOW).today.count, 0);
});

test("revenue and fee for the period count what stayed after refunds, and refunds are shown separately", () => {
  const done = confirmed({ startAt: NOW + 2 * HOUR });
  finish(done);
  const half = confirmed({ customerId: "c2", playerId: "p2", startAt: NOW + 4 * HOUR });
  bk.cancel(half.id, { role: "customer", userId: "c2" }, NOW + 10 * MIN);
  const full = confirmed({ startAt: NOW + 6 * HOUR });
  bk.noShow(full.id, "player", SYSTEM, NOW + 6 * HOUR + 15 * MIN);
  const s = ownerSummary(NOW + 7 * HOUR);
  // done: fee 10,000 + payout 90,000. half (cancel 3h50 before the start: the middle tier): refund 50,000, fee 5,000, payout 45,000. full refund: 100,000 back.
  assert.equal(s.period.feeVnd, 15_000);
  assert.equal(s.period.playerShareVnd, 135_000);
  assert.equal(s.period.revenueVnd, 150_000);
  assert.equal(s.period.refundedVnd, 150_000);
  assert.equal(s.period.bookings, 3);
  assert.equal(s.period.revenueVnd + s.period.refundedVnd, 300_000, "all three bookings were paid 100,000 each");
});

test("the period only covers its days", () => {
  const old = confirmed({ startAt: NOW + 2 * HOUR });
  finish(old);
  const later = NOW + 9 * DAY;
  assert.equal(ownerSummary(later).period.revenueVnd, 0);
  assert.equal(ownerSummary(later, { periodDays: 30 }).period.revenueVnd, 100_000);
  assert.equal(ownerSummary(NOW + 3 * HOUR - 1).period.revenueVnd, 0, "nothing is written before the money moves");
});

test("pending applications, refunds, payouts (payable and held) and disputes are collected", () => {
  attest("new1", NOW);
  applyAsPlayer({ userId: "new1", displayName: "Mới", games: ["LoL"], rateVnd: 50_000, bio: "", languages: "" }, NOW);
  const done = confirmed({ startAt: NOW + 2 * HOUR });
  finish(done);
  const cancelled = confirmed({ customerId: "c2", playerId: "p2", startAt: NOW + 5 * HOUR });
  bk.cancel(cancelled.id, { role: "player", userId: "p2" }, NOW + 20 * MIN);
  const disputedBooking = confirmed({ startAt: NOW + 8 * HOUR });
  finish(disputedBooking);
  bk.openDispute(disputedBooking.id, { role: "customer", userId: "c1" }, "vấn đề", NOW + 10 * HOUR);

  const during = ownerSummary(NOW + 10 * HOUR);
  assert.deepEqual(during.pendingApplications.map((p) => p.userId), ["new1"]);
  assert.deepEqual(during.refunds, { count: 1, vnd: 100_000 });
  assert.deepEqual(during.payouts, { payableCount: 0, payableVnd: 0, heldCount: 1, heldVnd: 90_000 }, "the disputed payout is neither payable nor counted as held");
  assert.equal(during.openDisputes.length, 1);

  const after = ownerSummary(NOW + 2 * HOUR + HOUR + 24 * HOUR + MIN);
  assert.equal(after.payouts.payableCount, 1);
  assert.equal(after.payouts.payableVnd, 90_000);
});

test("playerEarnings: held, payable and paid are kept apart", () => {
  const a = confirmed({ startAt: NOW + 2 * HOUR });
  finish(a);
  const b = confirmed({ customerId: "c2", startAt: NOW + 5 * HOUR });
  finish(b);
  const midway = NOW + 3 * HOUR + 24 * HOUR + MIN; // a is releasable, b still held
  const e = playerEarnings("p1", midway);
  assert.deepEqual([e.owedVnd, e.heldVnd, e.paidVnd, e.lifetimeVnd], [90_000, 90_000, 0, 180_000]);
  assert.equal(e.completed, 2);
  const payout = pendingPayouts(midway)[0];
  markPaid(payout.id, "owner", "ck", midway);
  const e2 = playerEarnings("p1", midway);
  assert.deepEqual([e2.owedVnd, e2.heldVnd, e2.paidVnd, e2.lifetimeVnd, e2.payoutsPaid], [0, 90_000, 90_000, 180_000, 1]);
});

test("playerEarnings: rating, upcoming bookings and an unknown player", () => {
  const a = confirmed({ startAt: NOW + 2 * HOUR });
  finish(a);
  recordRating(a.id, "c1", 4, "", NOW + 4 * HOUR);
  const next = confirmed({ customerId: "c2", startAt: NOW + 2 * DAY });
  const e = playerEarnings("p1", NOW + 5 * HOUR);
  assert.equal(e.average, 4);
  assert.equal(e.ratingCount, 1);
  assert.equal(e.upcomingCount, 1);
  assert.equal(e.nextBookingAt, next.start_at);
  const ghost = playerEarnings("ghost", NOW);
  assert.deepEqual([ghost.owedVnd, ghost.heldVnd, ghost.paidVnd, ghost.completed, ghost.average, ghost.upcomingCount, ghost.nextBookingAt], [0, 0, 0, 0, 0, 0, null]);
});

test("one player's earnings never include another's", () => {
  const a = confirmed({ startAt: NOW + 2 * HOUR, playerId: "p1" });
  finish(a);
  const b = confirmed({ customerId: "c2", startAt: NOW + 2 * HOUR, playerId: "p2" });
  finish(b);
  assert.equal(playerEarnings("p1", NOW + 2 * DAY).lifetimeVnd, 90_000);
  assert.equal(playerEarnings("p2", NOW + 2 * DAY).lifetimeVnd, 90_000);
});
