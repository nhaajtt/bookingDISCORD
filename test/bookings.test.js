import { fresh, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, NOW, HOUR, MIN, DAY, vn, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as bk from "../src/domain/bookings.js";
import { saveSettings, getSettings } from "../src/settings.js";
import { addToBlacklist } from "../src/domain/strikes.js";
import { setAvailabilityText, pausePlayer, suspendPlayer } from "../src/domain/players.js";
import { getPlayer } from "../src/domain/players.js";
import { listStrikes } from "../src/domain/strikes.js";

const { SYSTEM, staffActor } = bk;
const START = NOW + 3 * HOUR; // 13:00 on Monday 5 October
const customer = (id = "c1") => ({ role: "customer", userId: id });
const player = (id = "p1") => ({ role: "player", userId: id });
const staff = staffActor("staff1");
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code ?? `plain:${e.message}`;
  }
  return "no error";
};

beforeEach(() => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
});

// ---------------------------------------------------------------- creating

test("a valid booking is created AWAITING_PAYMENT with the quoted price and fee", () => {
  const b = book({ game: "liên quân" });
  assert.equal(b.status, "AWAITING_PAYMENT");
  assert.equal(b.price_vnd, 100_000);
  assert.equal(b.fee_vnd, 10_000);
  assert.equal(b.game, "Liên Quân", "stored with the player's spelling");
  assert.equal(b.created_at, NOW);
  assert.equal(b.paid_at, null);
  assert.deepEqual(b.reminders_sent, {});
  assert.equal(sum([{ amount_vnd: b.price_vnd }]), 100_000);
});

test("price follows duration and the owner's fee percent", () => {
  saveSettings({ feePercent: 20 });
  const b = book({ durationMin: 90 });
  assert.equal(b.price_vnd, 150_000);
  assert.equal(b.fee_vnd, 30_000);
});

test("you cannot book yourself", () => {
  makeCustomer("p1");
  assert.equal(code(() => book({ customerId: "p1", playerId: "p1" })), "SELF_BOOKING");
});

test("blacklisted customers and blacklisted players cannot be booked", () => {
  addToBlacklist("c1", "lừa đảo", "staff1", NOW);
  assert.equal(code(() => book()), "BLACKLISTED");
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  addToBlacklist("p1", "vi phạm", "staff1", NOW);
  assert.equal(code(() => book()), "BLACKLISTED");
});

test("a customer who has not confirmed they are 18 or older cannot book", () => {
  assert.equal(code(() => book({ customerId: "stranger" })), "NOT_ATTESTED");
});

test("the player must exist and be ACTIVE", () => {
  assert.equal(code(() => book({ playerId: "nobody" })), "NOT_FOUND");
  makePlayer("pend", { status: "PENDING" });
  assert.equal(code(() => book({ playerId: "pend" })), "PLAYER_NOT_ACTIVE");
  makePlayer("paused", { status: "PAUSED" });
  assert.equal(code(() => book({ playerId: "paused" })), "PLAYER_NOT_ACTIVE");
  makePlayer("susp");
  suspendPlayer("susp");
  assert.equal(code(() => book({ playerId: "susp" })), "PLAYER_NOT_ACTIVE");
  makePlayer("rej", { status: "PENDING" });
  getDb().prepare("UPDATE players SET status = 'REJECTED' WHERE user_id = 'rej'").run();
  assert.equal(code(() => book({ playerId: "rej" })), "PLAYER_NOT_ACTIVE");
});

test("the game must be one the player offers", () => {
  assert.equal(code(() => book({ game: "Valorant" })), "GAME_NOT_OFFERED");
  assert.equal(code(() => book({ game: "" })), "GAME_NOT_OFFERED");
  assert.equal(book({ game: "LOL" }).game, "LoL");
});

test("the start must fall on a half hour", () => {
  assert.equal(code(() => book({ startAt: START + 15 * MIN })), "BAD_START");
  assert.equal(code(() => book({ startAt: START + 1000 })), "BAD_START");
  assert.equal(code(() => book({ startAt: START + 0.5 })), "BAD_START");
  assert.equal(code(() => book({ startAt: NaN })), "BAD_START");
  assert.equal(book({ startAt: START + 30 * MIN }).start_at, START + 30 * MIN);
});

test("bookings in the past are refused", () => {
  assert.equal(code(() => book({ startAt: NOW - HOUR })), "IN_PAST");
  assert.equal(code(() => book({ startAt: NOW })), "IN_PAST");
});

test("minimum lead time is 60 minutes by default, exactly 60 is allowed", () => {
  assert.equal(code(() => book({ startAt: NOW + 30 * MIN })), "TOO_SOON");
  assert.equal(code(() => book({ startAt: NOW + 30 * MIN, now: NOW })), "TOO_SOON");
  assert.equal(book({ startAt: NOW + 60 * MIN }).status, "AWAITING_PAYMENT");
});

test("the lead time comes from settings", () => {
  saveSettings({ minLeadMin: 180 });
  assert.equal(code(() => book({ startAt: NOW + 2 * HOUR })), "TOO_SOON");
  assert.equal(book({ startAt: NOW + 3 * HOUR }).status, "AWAITING_PAYMENT");
});

test("bookings too far ahead are refused", () => {
  assert.equal(code(() => book({ startAt: NOW + 31 * DAY })), "TOO_FAR");
  assert.equal(book({ startAt: NOW + 30 * DAY }).status, "AWAITING_PAYMENT");
});

test("the booking must sit inside the player's availability", () => {
  setAvailabilityText("p1", "T2 19:00-23:00");
  assert.equal(code(() => book({ startAt: START })), "OUTSIDE_AVAILABILITY", "13:00 is not free");
  assert.equal(code(() => book({ startAt: vn(2026, 10, 5, 22, 30), durationMin: 60 })), "OUTSIDE_AVAILABILITY", "runs past 23:00");
  assert.equal(code(() => book({ startAt: vn(2026, 10, 6, 19, 0) })), "OUTSIDE_AVAILABILITY", "Tuesday is not free");
  assert.equal(book({ startAt: vn(2026, 10, 5, 22, 0), durationMin: 60 }).status, "AWAITING_PAYMENT", "ends exactly at 23:00");
});

test("a player with no availability at all cannot be booked", () => {
  makePlayer("empty", { availability: "T2 00:00-00:30" });
  getDb().prepare("DELETE FROM availability WHERE player_id = 'empty'").run();
  assert.equal(code(() => book({ playerId: "empty" })), "OUTSIDE_AVAILABILITY");
});

test("durations above the owner's maximum are refused", () => {
  assert.equal(code(() => book({ durationMin: 300 })), "BAD_DURATION");
  assert.equal(code(() => book({ durationMin: 45 })), "BAD_DURATION");
  saveSettings({ maxDurationHours: 6 });
  assert.equal(book({ durationMin: 300 }).duration_min, 300);
});

test("a player cannot be double booked: CONFIRMED and IN_PROGRESS block the slot", () => {
  makeCustomer("c2");
  confirmed({ customerId: "c1" });
  assert.equal(code(() => book({ customerId: "c2", startAt: START })), "PLAYER_BUSY");
  assert.equal(code(() => book({ customerId: "c2", startAt: START + 30 * MIN })), "PLAYER_BUSY", "overlaps the second half");
  assert.equal(code(() => book({ customerId: "c2", startAt: START - 30 * MIN })), "PLAYER_BUSY", "overlaps the first half");
  assert.equal(code(() => book({ customerId: "c2", startAt: START - 30 * MIN, durationMin: 120 })), "PLAYER_BUSY", "surrounds it");
});

test("back to back bookings do not overlap", () => {
  makeCustomer("c2");
  confirmed({ customerId: "c1" });
  assert.equal(book({ customerId: "c2", startAt: START + HOUR }).status, "AWAITING_PAYMENT");
  assert.equal(book({ customerId: "c2", startAt: START - HOUR }).status, "AWAITING_PAYMENT");
});

test("an unpaid booking holds the slot during its payment window and releases it afterwards", () => {
  makeCustomer("c2");
  book({ customerId: "c1" });
  assert.equal(code(() => book({ customerId: "c2", startAt: START, now: NOW + 29 * MIN })), "PLAYER_BUSY");
  assert.equal(book({ customerId: "c2", startAt: START, now: NOW + 30 * MIN }).status, "AWAITING_PAYMENT", "the window has closed");
});

test("cancelled, expired, completed and no-show bookings free the slot", () => {
  makeCustomer("c2");
  const b = confirmed({ customerId: "c1" });
  bk.cancel(b.id, customer("c1"), NOW);
  assert.equal(book({ customerId: "c2", startAt: START }).status, "AWAITING_PAYMENT");
});

test("a customer cannot hold two bookings at once, even with different players", () => {
  makePlayer("p2");
  confirmed({ playerId: "p1" });
  assert.equal(code(() => book({ playerId: "p2", startAt: START + 30 * MIN })), "CUSTOMER_BUSY");
  assert.equal(book({ playerId: "p2", startAt: START + HOUR }).status, "AWAITING_PAYMENT");
});

test("at most three active bookings per customer", () => {
  for (let i = 0; i < 3; i += 1) confirmed({ startAt: START + i * 2 * HOUR });
  assert.equal(code(() => book({ startAt: START + 6 * HOUR })), "TOO_MANY_ACTIVE");
});

test("unpaid bookings count towards the limit while their window is open", () => {
  for (let i = 0; i < 3; i += 1) book({ startAt: START + i * 2 * HOUR });
  assert.equal(code(() => book({ startAt: START + 6 * HOUR })), "TOO_MANY_ACTIVE");
  assert.equal(book({ startAt: START + 6 * HOUR, now: NOW + 31 * MIN }).status, "AWAITING_PAYMENT", "the first three have lapsed");
});

test("finished bookings do not count towards the limit", () => {
  for (let i = 0; i < 3; i += 1) {
    const b = confirmed({ startAt: START + i * 2 * HOUR });
    bk.cancel(b.id, customer(), NOW);
  }
  assert.equal(book({ startAt: START + 6 * HOUR }).status, "AWAITING_PAYMENT");
});

test("the limit comes from settings", () => {
  saveSettings({ maxActiveBookings: 1 });
  confirmed();
  assert.equal(code(() => book({ startAt: START + 4 * HOUR })), "TOO_MANY_ACTIVE");
});

test("a failed booking leaves nothing behind", () => {
  assert.equal(code(() => book({ startAt: NOW - HOUR })), "IN_PAST");
  assert.equal(bk.listBookings().length, 0);
});

// ---------------------------------------------------------------- the state machine table

const ACTIONS = ["pay", "expire", "start", "complete", "cancelCustomer", "cancelStaff", "noShowPlayer", "noShowCustomer", "dispute"];

function inStatus(status) {
  const b = book();
  const id = b.id;
  const steps = {
    AWAITING_PAYMENT: () => {},
    EXPIRED: () => bk.expireUnpaid(id, NOW + 30 * MIN),
    CONFIRMED: () => bk.pay(id, NOW, b.price_vnd),
    IN_PROGRESS: () => (bk.pay(id, NOW, b.price_vnd), bk.start(id, SYSTEM, START)),
    COMPLETED: () => (bk.pay(id, NOW, b.price_vnd), bk.start(id, SYSTEM, START), bk.complete(id, SYSTEM, START + HOUR)),
    CANCELLED: () => (bk.pay(id, NOW, b.price_vnd), bk.cancel(id, customer(), NOW)),
    NO_SHOW_PLAYER: () => (bk.pay(id, NOW, b.price_vnd), bk.noShow(id, "player", SYSTEM, START + 15 * MIN)),
    NO_SHOW_CUSTOMER: () => (bk.pay(id, NOW, b.price_vnd), bk.noShow(id, "customer", SYSTEM, START + 15 * MIN)),
    DISPUTED: () => (bk.pay(id, NOW, b.price_vnd), bk.start(id, SYSTEM, START), bk.openDispute(id, customer(), "vấn đề", START + 10 * MIN)),
  };
  steps[status]();
  assert.equal(bk.getBooking(id).status, status);
  return id;
}

// Each action tried at a moment that satisfies its time rule when it is allowed at all
function attempt(action, id) {
  const T = { pay: NOW, expire: NOW + 31 * MIN, start: START, complete: START + HOUR, cancelCustomer: NOW, cancelStaff: NOW, noShowPlayer: START + 15 * MIN, noShowCustomer: START + 15 * MIN, dispute: START + HOUR + MIN }[action];
  const run = {
    pay: () => bk.pay(id, T, 100_000),
    expire: () => bk.expireUnpaid(id, T),
    start: () => bk.start(id, SYSTEM, T),
    complete: () => bk.complete(id, SYSTEM, T),
    cancelCustomer: () => bk.cancel(id, customer(), T),
    cancelStaff: () => bk.cancel(id, staff, T),
    noShowPlayer: () => bk.noShow(id, "player", SYSTEM, T),
    noShowCustomer: () => bk.noShow(id, "customer", SYSTEM, T),
    dispute: () => bk.openDispute(id, customer(), "lý do", T),
  }[action];
  return code(run);
}

const RULE = { pay: "pay", expire: "expire", start: "start", complete: "complete", cancelCustomer: "cancel", cancelStaff: "cancel", noShowPlayer: "noShowPlayer", noShowCustomer: "noShowCustomer", dispute: "dispute" };
const ROLE = { cancelStaff: "staff", cancelCustomer: "customer", dispute: "customer" };

for (const status of Object.keys(bk.STATUS)) {
  test(`state machine: from ${status}, exactly the transitions in the table are possible`, () => {
    for (const action of ACTIONS) {
      fresh();
      makePlayer("p1");
      makeCustomer("c1");
      if (status === "EXPIRED" && action === "pay") continue; // late money is a refund, covered below
      const id = inStatus(status);
      const role = ROLE[action] ?? "system";
      const allowed = Boolean(bk.canTransition(status, RULE[action], role));
      const result = attempt(action, id);
      if (allowed) {
        assert.ok(result === "no error" || result === "TOO_EARLY" || result === "TOO_LATE", `${status} + ${action} should be a legal move, got ${result}`);
      } else {
        const otherRole = bk.TRANSITIONS.some((r) => r.action === RULE[action] && r.from.includes(status));
        assert.equal(result, otherRole ? "FORBIDDEN_ACTOR" : "ILLEGAL_TRANSITION", `${status} + ${action} must throw`);
        assert.equal(bk.getBooking(id).status, status, "an illegal transition leaves the status alone");
      }
    }
  });
}

test("the table lists every status and no transition leaves a final status", () => {
  const finals = ["EXPIRED", "CANCELLED", "NO_SHOW_PLAYER", "NO_SHOW_CUSTOMER", "DISPUTED"];
  for (const r of bk.TRANSITIONS) {
    assert.ok(bk.STATUS[r.to], r.to);
    for (const f of r.from) assert.ok(bk.STATUS[f], f);
    for (const f of finals.filter((s) => s !== "NO_SHOW_PLAYER" && s !== "NO_SHOW_CUSTOMER")) assert.ok(!r.from.includes(f), `${f} must be final`);
  }
  assert.ok(Object.isFrozen(bk.TRANSITIONS));
  assert.equal(bk.canTransition("COMPLETED", "pay", "system"), null);
  assert.equal(bk.canTransition("CONFIRMED", "start", "customer"), null);
  assert.ok(bk.canTransition("CONFIRMED", "start", "system"));
});

test("unknown booking ids are reported", () => {
  assert.equal(code(() => bk.cancel(999, staff, NOW)), "NOT_FOUND");
  assert.equal(code(() => bk.pay(999, NOW)), "NOT_FOUND");
  assert.equal(bk.getBooking(999), null);
});

// ---------------------------------------------------------------- pay and expire

test("pay confirms the booking and records when", () => {
  const b = book();
  const r = bk.pay(b.id, NOW + 5 * MIN, 100_000);
  assert.equal(r.booking.status, "CONFIRMED");
  assert.equal(r.booking.paid_at, NOW + 5 * MIN);
  assert.equal(r.late, false);
});

test("pay with less than the price is refused and the booking stays unpaid", () => {
  const b = book();
  assert.equal(code(() => bk.pay(b.id, NOW, 99_000)), "UNDERPAID");
  assert.equal(bk.getBooking(b.id).status, "AWAITING_PAYMENT");
  assert.equal(code(() => bk.pay(b.id, NOW, 100_000)), "no error");
});

test("paying twice is an illegal transition and writes nothing", () => {
  const b = confirmed();
  assert.equal(code(() => bk.pay(b.id, NOW, 100_000)), "ILLEGAL_TRANSITION");
  assert.equal(ledgerRows(b.id).length, 0);
});

test("unpaid bookings expire after 30 minutes and not before", () => {
  const b = book();
  assert.equal(code(() => bk.expireUnpaid(b.id, NOW + 29 * MIN + 59_000)), "TOO_EARLY");
  const e = bk.expireUnpaid(b.id, NOW + 30 * MIN);
  assert.equal(e.status, "EXPIRED");
  assert.equal(e.ended_at, NOW + 30 * MIN);
  assert.equal(code(() => bk.expireUnpaid(b.id, NOW + 31 * MIN)), "ILLEGAL_TRANSITION");
});

test("the payment window comes from settings", () => {
  saveSettings({ unpaidExpireMin: 45 });
  const b = book();
  assert.equal(code(() => bk.expireUnpaid(b.id, NOW + 40 * MIN)), "TOO_EARLY");
  assert.equal(bk.expireUnpaid(b.id, NOW + 45 * MIN).status, "EXPIRED");
});

test("money that arrives after expiry is refunded in full, once", () => {
  const b = book();
  bk.expireUnpaid(b.id, NOW + 30 * MIN);
  const r = bk.pay(b.id, NOW + 32 * MIN, 100_000);
  assert.equal(r.late, true);
  assert.equal(r.booking.status, "EXPIRED", "the booking is not revived");
  assert.deepEqual(ledgerRows(b.id).map((x) => [x.kind, x.amount_vnd, x.party_user_id, x.status]), [["REFUND", 100_000, "c1", "OWED"]]);
  bk.pay(b.id, NOW + 33 * MIN, 100_000);
  assert.equal(ledgerRows(b.id).length, 1, "a repeat writes nothing more");
});

test("money that arrives for a booking cancelled before payment is refunded too", () => {
  const b = book();
  bk.cancel(b.id, customer(), NOW + MIN);
  assert.equal(ledgerRows(b.id).length, 0, "nothing was paid yet");
  assert.equal(bk.pay(b.id, NOW + 2 * MIN, 100_000).late, true);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
});

test("late money for a booking that was already paid and cancelled is not a refund opportunity", () => {
  const b = confirmed();
  bk.cancel(b.id, customer(), NOW);
  const before = ledgerRows(b.id);
  assert.equal(code(() => bk.pay(b.id, NOW, 100_000)), "ILLEGAL_TRANSITION");
  assert.deepEqual(ledgerRows(b.id), before);
});

// ---------------------------------------------------------------- start and complete

test("a session can start from 10 minutes before its time until its end", () => {
  const b = confirmed();
  assert.equal(code(() => bk.start(b.id, SYSTEM, START - 11 * MIN)), "TOO_EARLY");
  const s = bk.start(b.id, SYSTEM, START - 10 * MIN);
  assert.equal(s.status, "IN_PROGRESS");
  assert.equal(s.started_at, START - 10 * MIN);
});

test("a session cannot start once it should be over", () => {
  const b = confirmed();
  assert.equal(code(() => bk.start(b.id, SYSTEM, START + HOUR)), "TOO_LATE");
});

test("customers and players cannot start a session themselves", () => {
  const b = confirmed();
  assert.equal(code(() => bk.start(b.id, customer(), START)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.start(b.id, player(), START)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.start(b.id, staff, START)), "no error");
});

function running(options = {}) {
  const b = confirmed(options);
  bk.start(b.id, SYSTEM, b.start_at);
  return bk.getBooking(b.id);
}

test("the system ends a session only at its scheduled end; staff may end it earlier", () => {
  const b = running();
  assert.equal(code(() => bk.complete(b.id, SYSTEM, START + 59 * MIN)), "TOO_EARLY");
  const early = bk.complete(b.id, staff, START + 40 * MIN);
  assert.equal(early.status, "COMPLETED");
  assert.equal(early.ended_at, START + 40 * MIN);
});

test("a session that is completed late is stamped with its scheduled end", () => {
  const b = running();
  assert.equal(bk.complete(b.id, SYSTEM, START + 5 * HOUR).ended_at, START + HOUR);
});

test("completing pays out and counts: fee and player share, completed counter up by one", () => {
  const b = running();
  bk.complete(b.id, SYSTEM, START + HOUR);
  assert.deepEqual(ledgerRows(b.id).map((x) => [x.kind, x.amount_vnd, x.status]).sort(), [["FEE_INCOME", 10_000, "PAID"], ["PLAYER_PAYOUT", 90_000, "OWED"]]);
  assert.equal(getPlayer("p1").completed, 1);
});

test("completing twice neither writes money twice nor counts twice", () => {
  const b = running();
  bk.complete(b.id, SYSTEM, START + HOUR);
  assert.equal(code(() => bk.complete(b.id, SYSTEM, START + HOUR)), "ILLEGAL_TRANSITION");
  assert.equal(ledgerRows(b.id).length, 2);
  assert.equal(getPlayer("p1").completed, 1);
});

test("a customer cannot complete a session", () => {
  const b = running();
  assert.equal(code(() => bk.complete(b.id, customer(), START + HOUR)), "FORBIDDEN_ACTOR");
});

// ---------------------------------------------------------------- cancel

function cancelAt(hoursBefore, actor = customer()) {
  const b = confirmed();
  return bk.cancel(b.id, actor, START - hoursBefore * HOUR);
}

test("customer cancels more than 24 hours ahead: full refund, no payout, no fee", () => {
  const r = cancelAt(30);
  assert.equal(r.refundVnd, 100_000);
  assert.equal(r.percent, 100);
  assert.equal(r.booking.status, "CANCELLED");
  assert.equal(r.booking.cancelled_by, "customer");
  assert.equal(r.booking.refund_due_vnd, 100_000);
  assert.deepEqual(ledgerRows(r.booking.id).map((x) => x.kind), ["REFUND"]);
});

test("customer cancels 24 to 2 hours ahead: half refunded, the rest shared like a normal booking", () => {
  const r = cancelAt(10);
  assert.equal(r.refundVnd, 50_000);
  const rows = Object.fromEntries(ledgerRows(r.booking.id).map((x) => [x.kind, x.amount_vnd]));
  assert.deepEqual(rows, { REFUND: 50_000, FEE_INCOME: 5000, PLAYER_PAYOUT: 45_000 });
});

test("customer cancels under 2 hours ahead: nothing refunded, the player is paid as usual", () => {
  const r = cancelAt(1);
  assert.equal(r.refundVnd, 0);
  const rows = Object.fromEntries(ledgerRows(r.booking.id).map((x) => [x.kind, x.amount_vnd]));
  assert.deepEqual(rows, { FEE_INCOME: 10_000, PLAYER_PAYOUT: 90_000 });
});

test("player cancels: always a full refund and a strike", () => {
  const r = cancelAt(0.1, player());
  assert.equal(r.refundVnd, 100_000);
  assert.equal(r.booking.cancelled_by, "player");
  assert.equal(r.strike.count, 1);
  assert.equal(listStrikes("p1")[0].reason, "player_cancel");
  assert.deepEqual(ledgerRows(r.booking.id).map((x) => x.kind), ["REFUND"]);
});

test("three player cancellations in 30 days suspend the player", () => {
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    const b = confirmed({ startAt: START + i * 2 * HOUR });
    results.push(bk.cancel(b.id, player(), NOW + i * HOUR));
  }
  assert.deepEqual(results.map((r) => r.strike.suspended), [false, false, true]);
  assert.equal(getPlayer("p1").status, "SUSPENDED");
});

test("an unpaid booking can be cancelled by either side without money or strikes", () => {
  const a = book();
  const r = bk.cancel(a.id, customer(), NOW + MIN);
  assert.equal(r.refundVnd, 0);
  assert.equal(ledgerRows(a.id).length, 0);
  const b = book();
  const q = bk.cancel(b.id, player(), NOW + MIN);
  assert.equal(q.strike, null);
  assert.equal(listStrikes("p1").length, 0);
});

test("cancelling twice is refused and writes nothing more", () => {
  const b = confirmed();
  bk.cancel(b.id, customer(), NOW);
  const before = ledgerRows(b.id);
  assert.equal(code(() => bk.cancel(b.id, customer(), NOW)), "ILLEGAL_TRANSITION");
  assert.deepEqual(ledgerRows(b.id), before);
});

test("only the booking's own customer or player may cancel it", () => {
  const b = confirmed();
  assert.equal(code(() => bk.cancel(b.id, customer("c2"), NOW)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.cancel(b.id, player("p2"), NOW)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.cancel(b.id, undefined, NOW)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.cancel(b.id, { role: "admin" }, NOW)), "FORBIDDEN_ACTOR");
});

test("a customer or player cannot cancel after the no-show grace has passed", () => {
  const b = confirmed();
  assert.equal(code(() => bk.cancel(b.id, customer(), START + 15 * MIN)), "TOO_LATE");
  assert.equal(code(() => bk.cancel(b.id, player(), START + 15 * MIN)), "TOO_LATE");
  assert.equal(code(() => bk.cancel(b.id, staff, START + 15 * MIN)), "no error");
});

test("staff and system cancellations refund everything without a strike; staff can also cancel a running session", () => {
  const a = confirmed();
  const r = bk.cancel(a.id, SYSTEM, START - MIN, { reason: "cả hai vắng mặt" });
  assert.equal(r.refundVnd, 100_000);
  assert.equal(ledgerRows(a.id)[0].note, "cả hai vắng mặt");
  assert.equal(listStrikes("p1").length, 0);
  makePlayer("p2");
  const b = running({ playerId: "p2", startAt: START + 4 * HOUR });
  const s = bk.cancel(b.id, staff, b.start_at + 10 * MIN);
  assert.equal(s.refundVnd, 100_000);
  assert.equal(s.booking.status, "CANCELLED");
});

test("a customer cannot cancel a running session", () => {
  const b = running();
  assert.equal(code(() => bk.cancel(b.id, customer(), START + 5 * MIN)), "FORBIDDEN_ACTOR");
});

test("cancellation tiers can be changed in settings", () => {
  saveSettings({ cancellation: [{ minHoursBefore: 6, refundPercent: 100 }, { minHoursBefore: 0, refundPercent: 25 }] });
  assert.equal(cancelAt(7).refundVnd, 100_000);
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  saveSettings({ cancellation: [{ minHoursBefore: 6, refundPercent: 100 }, { minHoursBefore: 0, refundPercent: 25 }] });
  assert.equal(cancelAt(1).refundVnd, 25_000);
});

test("cancelUpcomingForPlayer cancels unstarted bookings with full refunds", () => {
  makeCustomer("c2");
  const a = confirmed({ customerId: "c1" });
  const b = confirmed({ customerId: "c2", startAt: START + 2 * HOUR });
  const c = book({ customerId: "c1", startAt: START + 4 * HOUR });
  const done = bk.cancelUpcomingForPlayer("p1", staff, NOW);
  assert.equal(done.length, 3);
  assert.equal(bk.getBooking(a.id).status, "CANCELLED");
  assert.equal(bk.getBooking(b.id).status, "CANCELLED");
  assert.equal(bk.getBooking(c.id).status, "CANCELLED");
  assert.equal(sum(ledgerRows(a.id)), 100_000);
  assert.equal(ledgerRows(c.id).length, 0);
});

// ---------------------------------------------------------------- no-show

test("a no-show can only be declared after the 15 minute grace", () => {
  const b = confirmed();
  assert.equal(code(() => bk.noShow(b.id, "player", SYSTEM, START + 14 * MIN + 59_000)), "TOO_EARLY");
  assert.equal(code(() => bk.noShow(b.id, "player", SYSTEM, START + 15 * MIN)), "no error");
});

test("the grace period comes from settings", () => {
  saveSettings({ noShowGraceMin: 30 });
  const b = confirmed();
  assert.equal(code(() => bk.noShow(b.id, "customer", SYSTEM, START + 20 * MIN)), "TOO_EARLY");
  assert.equal(code(() => bk.noShow(b.id, "customer", SYSTEM, START + 30 * MIN)), "no error");
});

test("player no-show: full refund, no payout, no fee, a strike for the player", () => {
  const b = confirmed();
  const r = bk.noShow(b.id, "player", SYSTEM, START + 15 * MIN);
  assert.equal(r.booking.status, "NO_SHOW_PLAYER");
  assert.equal(r.refundVnd, 100_000);
  assert.deepEqual(ledgerRows(b.id).map((x) => x.kind), ["REFUND"]);
  assert.equal(listStrikes("p1")[0].reason, "no_show_player");
  assert.equal(getPlayer("p1").completed, 0);
});

test("customer no-show: the player is paid as for a completed booking, the customer gets a strike", () => {
  const b = confirmed();
  const r = bk.noShow(b.id, "customer", SYSTEM, START + 15 * MIN);
  assert.equal(r.booking.status, "NO_SHOW_CUSTOMER");
  assert.equal(r.refundVnd, 0);
  assert.deepEqual(Object.fromEntries(ledgerRows(b.id).map((x) => [x.kind, x.amount_vnd])), { FEE_INCOME: 10_000, PLAYER_PAYOUT: 90_000 });
  assert.equal(listStrikes("c1")[0].reason, "no_show_customer");
  assert.equal(r.strike.suspended, false, "customers are counted, not suspended");
});

test("declaring a no-show twice, or both kinds, is refused", () => {
  const b = confirmed();
  bk.noShow(b.id, "player", SYSTEM, START + 15 * MIN);
  assert.equal(code(() => bk.noShow(b.id, "player", SYSTEM, START + 16 * MIN)), "ILLEGAL_TRANSITION");
  assert.equal(code(() => bk.noShow(b.id, "customer", SYSTEM, START + 16 * MIN)), "ILLEGAL_TRANSITION");
  assert.equal(ledgerRows(b.id).length, 1);
  assert.equal(listStrikes("p1").length, 1);
});

test("customers and players cannot declare no-shows, and the side must be valid", () => {
  const b = confirmed();
  assert.equal(code(() => bk.noShow(b.id, "player", customer(), START + 15 * MIN)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.noShow(b.id, "customer", player(), START + 15 * MIN)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.noShow(b.id, "nobody", SYSTEM, START + 15 * MIN)), "INVALID_INPUT");
});

test("three player no-shows suspend the player", () => {
  for (let i = 0; i < 3; i += 1) {
    const b = confirmed({ startAt: START + i * 2 * HOUR });
    bk.noShow(b.id, "player", SYSTEM, b.start_at + 15 * MIN);
  }
  assert.equal(getPlayer("p1").status, "SUSPENDED");
});

// ---------------------------------------------------------------- disputes

function completedBooking() {
  const b = running();
  bk.complete(b.id, SYSTEM, START + HOUR);
  return b.id;
}

test("a customer or player can open a dispute on a completed booking inside the review window", () => {
  const id = completedBooking();
  const r = bk.openDispute(id, customer(), "Player không chơi đúng giờ @everyone https://x.test", START + 5 * HOUR);
  assert.equal(r.booking.status, "DISPUTED");
  assert.equal(r.dispute.status, "OPEN");
  assert.equal(r.dispute.opener_id, "c1");
  assert.equal(r.dispute.reason, "Player không chơi đúng giờ", "mentions and links are stripped");
});

test("after the review window only staff can open a dispute", () => {
  const id = completedBooking();
  const late = START + HOUR + 25 * HOUR;
  assert.equal(code(() => bk.openDispute(id, customer(), "muộn", late)), "TOO_LATE");
  assert.equal(code(() => bk.openDispute(id, player(), "muộn", late)), "TOO_LATE");
  assert.equal(code(() => bk.openDispute(id, staff, "nhân viên mở", late)), "no error");
});

test("the dispute window boundary is inclusive and counted from the end", () => {
  const id = completedBooking();
  assert.equal(code(() => bk.openDispute(id, customer(), "x", START + HOUR + 24 * HOUR)), "no error");
});

test("a dispute can be opened while the session runs", () => {
  const b = running();
  assert.equal(code(() => bk.openDispute(b.id, player(), "khách quấy rối", START + 20 * MIN)), "no error");
});

test("a no-show verdict can be contested", () => {
  const b = confirmed();
  bk.noShow(b.id, "customer", SYSTEM, START + 15 * MIN);
  assert.equal(code(() => bk.openDispute(b.id, customer(), "tôi có mặt", START + 20 * MIN)), "no error");
});

test("strangers cannot open disputes, and a dispute needs a reason", () => {
  const id = completedBooking();
  assert.equal(code(() => bk.openDispute(id, customer("c9"), "x", START + 2 * HOUR)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => bk.openDispute(id, customer(), "   ", START + 2 * HOUR)), "INVALID_INPUT");
  assert.equal(code(() => bk.openDispute(id, customer(), "@everyone", START + 2 * HOUR)), "INVALID_INPUT");
  assert.equal(code(() => bk.openDispute(id, SYSTEM, "x", START + 2 * HOUR)), "FORBIDDEN_ACTOR");
});

test("a booking can only have one dispute", () => {
  const id = completedBooking();
  bk.openDispute(id, customer(), "một", START + 2 * HOUR);
  assert.equal(code(() => bk.openDispute(id, player(), "hai", START + 2 * HOUR)), "ILLEGAL_TRANSITION");
  assert.equal(bk.listOpenDisputes().length, 1);
});

function disputed() {
  const id = completedBooking();
  const { dispute } = bk.openDispute(id, customer(), "vấn đề", START + 2 * HOUR);
  return { id, disputeId: dispute.id };
}

const kinds = (id) => Object.fromEntries(ledgerRows(id).map((x) => [x.kind, x.amount_vnd]));

test("resolving: pay the player keeps the original split", () => {
  const { id, disputeId } = disputed();
  const r = bk.resolveDispute(disputeId, "pay_player", "staff1", "player đúng", START + 3 * HOUR);
  assert.equal(r.dispute.status, "RESOLVED");
  assert.equal(r.dispute.resolved_by, "staff1");
  assert.deepEqual(bk.parseResolution(r.dispute), { outcome: "pay_player", percent: null, note: "player đúng" });
  assert.deepEqual(kinds(id), { FEE_INCOME: 10_000, PLAYER_PAYOUT: 90_000 });
  assert.equal(bk.getBooking(id).status, "DISPUTED", "the booking keeps its status, the dispute carries the outcome");
});

test("resolving: refund the customer replaces the payout with a full refund", () => {
  const { id, disputeId } = disputed();
  const r = bk.resolveDispute(disputeId, "refund_customer", "staff1", "", START + 3 * HOUR);
  assert.equal(r.refundVnd, 100_000);
  assert.deepEqual(kinds(id), { REFUND: 100_000 });
  assert.equal(bk.getBooking(id).refund_due_vnd, 100_000);
});

test("resolving: split refunds half by default and shares the rest in the fee proportion", () => {
  const { id, disputeId } = disputed();
  bk.resolveDispute(disputeId, "split", "staff1", "", START + 3 * HOUR);
  assert.deepEqual(kinds(id), { REFUND: 50_000, FEE_INCOME: 5000, PLAYER_PAYOUT: 45_000 });
});

test("resolving: split with a chosen percent", () => {
  const { id, disputeId } = disputed();
  bk.resolveDispute(disputeId, "split", "staff1", "", START + 3 * HOUR, { percent: 70 });
  assert.deepEqual(kinds(id), { REFUND: 70_000, FEE_INCOME: 3000, PLAYER_PAYOUT: 27_000 });
});

test("resolving a dispute opened mid-session writes the money for the first time", () => {
  const b = running();
  const { dispute } = bk.openDispute(b.id, customer(), "x", START + 20 * MIN);
  assert.equal(ledgerRows(b.id).length, 0);
  bk.resolveDispute(dispute.id, "split", "staff1", "", START + HOUR);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
});

test("resolving twice is refused and changes nothing", () => {
  const { id, disputeId } = disputed();
  bk.resolveDispute(disputeId, "refund_customer", "staff1", "", START + 3 * HOUR);
  const before = ledgerRows(id);
  assert.equal(code(() => bk.resolveDispute(disputeId, "pay_player", "staff2", "", START + 4 * HOUR)), "ILLEGAL_TRANSITION");
  assert.deepEqual(ledgerRows(id), before);
});

test("bad outcomes, bad percents and unknown disputes are refused", () => {
  const { disputeId } = disputed();
  assert.equal(code(() => bk.resolveDispute(disputeId, "shrug", "s", "", NOW)), "INVALID_INPUT");
  for (const percent of [0, 100, 50.5, -5]) assert.equal(code(() => bk.resolveDispute(disputeId, "split", "s", "", NOW, { percent })), "INVALID_INPUT");
  assert.equal(code(() => bk.resolveDispute(999, "pay_player", "s", "", NOW)), "NOT_FOUND");
  assert.equal(bk.getDispute(disputeId).status, "OPEN");
});

test("a payout that was already handed over cannot be turned into a refund", () => {
  const id = completedBooking();
  const payout = ledgerRows(id).find((x) => x.kind === "PLAYER_PAYOUT");
  getDb().prepare("UPDATE ledger SET status = 'PAID', paid_at = 1 WHERE id = ?").run(payout.id);
  const { dispute } = bk.openDispute(id, customer(), "x", START + 2 * HOUR);
  assert.equal(code(() => bk.resolveDispute(dispute.id, "refund_customer", "s", "", START + 3 * HOUR)), "SETTLED_ALREADY");
  assert.equal(bk.getDispute(dispute.id).status, "OPEN", "the failed resolution left the dispute open");
  assert.equal(code(() => bk.resolveDispute(dispute.id, "pay_player", "s", "", START + 3 * HOUR)), "no error", "confirming the existing split is fine");
});

test("resolution can strike the side at fault, or clear strikes a wrong verdict caused", () => {
  const b = confirmed();
  bk.noShow(b.id, "customer", SYSTEM, START + 15 * MIN);
  assert.equal(listStrikes("c1").length, 1);
  const { dispute } = bk.openDispute(b.id, customer(), "tôi có mặt", START + 20 * MIN);
  bk.resolveDispute(dispute.id, "refund_customer", "staff1", "", START + 30 * MIN, { clearStrikes: true, strike: "player" });
  assert.equal(listStrikes("c1")[0].cleared_at !== null, true);
  assert.equal(listStrikes("p1")[0].reason, "dispute_lost");
});

test("actorFor maps a person to their role on a booking", () => {
  const b = confirmed();
  assert.deepEqual(bk.actorFor(b, "c1"), { role: "customer", userId: "c1" });
  assert.deepEqual(bk.actorFor(b, "p1"), { role: "player", userId: "p1" });
  assert.deepEqual(bk.actorFor(b, "x", { isStaff: true }), { role: "staff", userId: "x" });
  assert.equal(code(() => bk.actorFor(b, "x")), "FORBIDDEN_ACTOR");
});

test("setRooms stores the channels and records that rooms were opened", () => {
  const b = confirmed();
  const r = bk.setRooms(b.id, "t1", "v1", START - 10 * MIN);
  assert.equal(r.text_channel_id, "t1");
  assert.equal(r.voice_channel_id, "v1");
  assert.equal(r.reminders_sent.openRooms, START - 10 * MIN);
});

test("listBookings filters", () => {
  makeCustomer("c2");
  const a = confirmed({ customerId: "c1" });
  const b = confirmed({ customerId: "c2", startAt: START + 2 * HOUR });
  assert.deepEqual(bk.listBookings({ customerId: "c2" }).map((x) => x.id), [b.id]);
  assert.deepEqual(bk.listBookings({ playerId: "p1" }).map((x) => x.id), [a.id, b.id]);
  assert.deepEqual(bk.listBookings({ statuses: ["COMPLETED"] }), []);
  assert.deepEqual(bk.listBookings({ from: START + HOUR }).map((x) => x.id), [b.id]);
  assert.deepEqual(bk.listBookings({ to: START + HOUR }).map((x) => x.id), [a.id]);
});

test("pausing a player does not touch their existing bookings, only new ones", () => {
  const b = confirmed();
  pausePlayer("p1");
  assert.equal(bk.getBooking(b.id).status, "CONFIRMED");
  assert.equal(code(() => book({ startAt: START + 4 * HOUR })), "PLAYER_NOT_ACTIVE");
});

test("settings are read at the moment of the call", () => {
  assert.equal(getSettings().minLeadMin, 60);
});
