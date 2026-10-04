import { fresh, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, NOW, HOUR, MIN, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as bk from "../src/domain/bookings.js";
import * as ledger from "../src/domain/ledger.js";
import { saveSettings } from "../src/settings.js";

const { SYSTEM, staffActor } = bk;
const START = NOW + 3 * HOUR;
const DAYS = (n) => n * 24 * HOUR;
const customer = { role: "customer", userId: "c1" };
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

// Everything that must hold for the money of one booking, whatever path produced it
function assertInvariant(id, label = "") {
  const b = bk.getBooking(id);
  const rows = ledgerRows(id);
  assert.equal(sum(rows), b.price_vnd, `${label}: rows must add up to the amount paid`);
  for (const r of rows) {
    assert.ok(Number.isInteger(r.amount_vnd) && r.amount_vnd > 0, `${label}: ${r.kind} must be a positive whole amount`);
    assert.equal(r.status, r.kind === "FEE_INCOME" ? "PAID" : "OWED");
  }
  assert.equal(new Set(rows.map((r) => r.kind)).size, rows.length, `${label}: one row per kind`);
  const by = (kind) => rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.amount_vnd, 0);
  assert.equal(by("REFUND"), b.refund_due_vnd, `${label}: the booking remembers what it owes back`);
  assert.ok(by("FEE_INCOME") <= b.fee_vnd, `${label}: never more fee than quoted`);
  assert.ok(by("REFUND") <= b.price_vnd);
  const check = ledger.checkBookingLedger(id, b.price_vnd);
  assert.equal(check.ok, true);
  return rows;
}

const PRICES = [
  { rate: 20_000, min: 30 },
  { rate: 21_000, min: 30 },
  { rate: 33_000, min: 90 },
  { rate: 150_000, min: 60 },
  { rate: 77_000, min: 210 },
  { rate: 500_000, min: 240 },
];

function paths(id, startAt) {
  return {
    completed: () => (bk.start(id, SYSTEM, startAt), bk.complete(id, SYSTEM, bk.endOf(bk.getBooking(id)))),
    noShowCustomer: () => bk.noShow(id, "customer", SYSTEM, startAt + 15 * MIN),
    noShowPlayer: () => bk.noShow(id, "player", SYSTEM, startAt + 15 * MIN),
    cancelEarly: () => bk.cancel(id, customer, startAt - 48 * HOUR),
    cancelMiddle: () => bk.cancel(id, customer, startAt - 10 * HOUR),
    cancelLate: () => bk.cancel(id, customer, startAt - HOUR),
    cancelPlayer: () => bk.cancel(id, { role: "player", userId: "p1" }, startAt - HOUR),
    cancelStaff: () => bk.cancel(id, staff, startAt - HOUR),
    disputePay: () => (bk.start(id, SYSTEM, startAt), bk.resolveDispute(bk.openDispute(id, customer, "x", startAt + MIN).dispute.id, "pay_player", "s", "", startAt + HOUR)),
    disputeRefund: () => (bk.start(id, SYSTEM, startAt), bk.resolveDispute(bk.openDispute(id, customer, "x", startAt + MIN).dispute.id, "refund_customer", "s", "", startAt + HOUR)),
    disputeSplit: () => (bk.start(id, SYSTEM, startAt), bk.resolveDispute(bk.openDispute(id, customer, "x", startAt + MIN).dispute.id, "split", "s", "", startAt + HOUR, { percent: 33 })),
    disputeAfterComplete: () => (bk.start(id, SYSTEM, startAt), bk.complete(id, SYSTEM, startAt + 4 * HOUR), bk.resolveDispute(bk.openDispute(id, customer, "x", startAt + 5 * HOUR).dispute.id, "split", "s", "", startAt + 6 * HOUR, { percent: 61 })),
  };
}

test("INVARIANT: for every path, price, duration and fee percent the rows add up exactly, nothing negative, nothing doubled", () => {
  let checked = 0;
  for (const feePercent of [0, 10, 33]) {
    for (const { rate, min } of PRICES) {
      for (const name of Object.keys(paths(0, 0))) {
        fresh();
        saveSettings({ feePercent, maxDurationHours: 6 });
        makePlayer("p1", { rateVnd: rate });
        makeCustomer("c1");
        const b = confirmed({ durationMin: min });
        paths(b.id, b.start_at)[name]();
        assertInvariant(b.id, `${name} rate ${rate} min ${min} fee ${feePercent}%`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 3 * 6 * 12);
});

test("completed: the whole price splits into fee and player share", () => {
  const b = confirmed();
  paths(b.id, START).completed();
  assert.deepEqual(Object.fromEntries(ledgerRows(b.id).map((r) => [r.kind, r.amount_vnd])), { FEE_INCOME: 10_000, PLAYER_PAYOUT: 90_000 });
});

test("a full refund keeps no fee and no payout; no refund keeps exactly the quoted fee", () => {
  const a = confirmed();
  paths(a.id, START).noShowPlayer();
  assert.deepEqual(ledgerRows(a.id).map((r) => r.kind), ["REFUND"]);
  makePlayer("p2");
  const c = confirmed({ playerId: "p2" });
  paths(c.id, START).noShowCustomer();
  const rows = Object.fromEntries(ledgerRows(c.id).map((r) => [r.kind, r.amount_vnd]));
  assert.equal(rows.FEE_INCOME, c.fee_vnd);
  assert.equal(rows.PLAYER_PAYOUT, c.price_vnd - c.fee_vnd);
  assert.equal(rows.REFUND, undefined);
});

test("a partial refund shares the kept part in the quoted proportion, rounded down for the fee", () => {
  assert.deepEqual(ledger.planSettlement(100_000, 10_000, 50_000), { refundVnd: 50_000, feeKeptVnd: 5000, payoutVnd: 45_000 });
  assert.deepEqual(ledger.planSettlement(100_000, 10_000, 33_000), { refundVnd: 33_000, feeKeptVnd: 6700, payoutVnd: 60_300 });
  assert.deepEqual(ledger.planSettlement(10_500, 1000, 5250), { refundVnd: 5250, feeKeptVnd: 500, payoutVnd: 4750 });
  assert.deepEqual(ledger.planSettlement(100_000, 0, 40_000), { refundVnd: 40_000, feeKeptVnd: 0, payoutVnd: 60_000 });
  assert.deepEqual(ledger.planSettlement(0, 0, 0), { refundVnd: 0, feeKeptVnd: 0, payoutVnd: 0 });
});

test("planSettlement conserves every dong for a sweep of refunds", () => {
  for (const price of [500, 10_500, 100_000, 399_500]) {
    for (const fee of [0, 1000, Math.min(price, 40_000)].filter((x) => x <= price)) {
      for (let refund = 0; refund <= price; refund += Math.max(1, Math.floor(price / 97))) {
        const p = ledger.planSettlement(price, fee, refund);
        assert.equal(p.refundVnd + p.feeKeptVnd + p.payoutVnd, price);
        assert.ok(p.feeKeptVnd >= 0 && p.payoutVnd >= 0 && p.feeKeptVnd <= fee);
      }
    }
  }
});

test("planSettlement refuses refunds outside 0..price", () => {
  for (const bad of [-1, 100_001, 0.5, NaN, "5"]) assert.throws(() => ledger.planSettlement(100_000, 10_000, bad), (e) => e.code === "INVALID_INPUT");
});

test("settling the same booking twice writes the rows once", () => {
  const b = confirmed();
  const first = ledger.settleBooking(b.id, 0, NOW);
  const second = ledger.settleBooking(b.id, 0, NOW + MIN);
  const third = ledger.settleBooking(b.id, 100_000, NOW + 2 * MIN);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(third.created, false, "a different amount without replace is ignored, not stacked on top");
  assert.equal(ledgerRows(b.id).length, 2);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
});

test("the database itself refuses a second row of the same kind for a booking", () => {
  const b = confirmed();
  ledger.settleBooking(b.id, 0, NOW);
  assert.throws(() => getDb().prepare("INSERT INTO ledger (booking_id, kind, party_user_id, amount_vnd, status, created_at) VALUES (?, 'PLAYER_PAYOUT', 'p1', 5, 'OWED', 0)").run(b.id));
});

test("the database refuses negative amounts", () => {
  const b = confirmed();
  assert.throws(() => getDb().prepare("INSERT INTO ledger (booking_id, kind, party_user_id, amount_vnd, status, created_at) VALUES (?, 'REFUND', 'c1', -5, 'OWED', 0)").run(b.id));
});

test("settling needs an existing booking", () => {
  assert.equal(code(() => ledger.settleBooking(999, 0, NOW)), "NOT_FOUND");
});

test("a replace with the same plan is a no-op; with another plan it swaps the rows", () => {
  const b = confirmed();
  ledger.settleBooking(b.id, 0, NOW);
  const same = ledger.settleBooking(b.id, 0, NOW + MIN, { replace: true });
  assert.equal(same.created, false);
  const swapped = ledger.settleBooking(b.id, 100_000, NOW + MIN, { replace: true });
  assert.equal(swapped.created, true);
  assert.deepEqual(ledgerRows(b.id).map((r) => r.kind), ["REFUND"]);
  assertInvariant(b.id);
});

test("refundLatePayment is idempotent and refuses nothing it should keep", () => {
  const b = book();
  const one = ledger.refundLatePayment(b.id, 100_000, NOW);
  const two = ledger.refundLatePayment(b.id, 100_000, NOW + MIN);
  assert.equal(one.created, true);
  assert.equal(two.created, false);
  assert.equal(ledgerRows(b.id).length, 1);
  assert.equal(bk.getBooking(b.id).refund_due_vnd, 100_000);
});

// ---------------------------------------------------------------- markPaid, owedTo, pending lists

function completedAt(extra = {}) {
  const b = confirmed(extra);
  bk.start(b.id, SYSTEM, b.start_at);
  bk.complete(b.id, SYSTEM, bk.endOf(b));
  return bk.getBooking(b.id);
}

const AFTER_WINDOW = START + HOUR + 24 * HOUR;

test("a payout is held until the review window after the end has passed", () => {
  const b = completedAt();
  const payout = ledgerRows(b.id).find((r) => r.kind === "PLAYER_PAYOUT");
  assert.equal(ledger.pendingPayouts(START + 2 * HOUR).length, 0, "still held");
  assert.equal(ledger.pendingPayouts(START + 2 * HOUR, { includeHeld: true }).length, 1);
  assert.equal(ledger.pendingPayouts(START + 2 * HOUR, { includeHeld: true })[0].releaseAt, AFTER_WINDOW);
  assert.equal(ledger.pendingPayouts(AFTER_WINDOW - 1).length, 0);
  assert.equal(ledger.pendingPayouts(AFTER_WINDOW).length, 1, "released exactly at the end of the window");
  assert.equal(code(() => ledger.markPaid(payout.id, "owner", null, START + 2 * HOUR)), "PAYOUT_HELD");
  assert.equal(code(() => ledger.markPaid(payout.id, "owner", "chuyển sớm", START + 2 * HOUR, { force: true })), "no error");
});

test("markPaid marks once and says so the second time", () => {
  const b = completedAt();
  const payout = ledgerRows(b.id).find((r) => r.kind === "PLAYER_PAYOUT");
  const first = ledger.markPaid(payout.id, "owner1", "ck 14h", AFTER_WINDOW, {});
  assert.equal(first.alreadyPaid, false);
  assert.equal(first.row.status, "PAID");
  assert.equal(first.row.paid_at, AFTER_WINDOW);
  assert.equal(first.row.paid_by, "owner1");
  assert.equal(first.row.note, "ck 14h");
  const second = ledger.markPaid(payout.id, "owner2", "again", AFTER_WINDOW + HOUR);
  assert.equal(second.alreadyPaid, true);
  const row = ledgerRows(b.id).find((r) => r.id === payout.id);
  assert.equal(row.paid_by, "owner1", "the first record is not overwritten");
  assert.equal(row.paid_at, AFTER_WINDOW);
  assert.equal(row.note, "ck 14h");
});

test("a paid row leaves every pending list and the owed balance", () => {
  const b = completedAt();
  const payout = ledgerRows(b.id).find((r) => r.kind === "PLAYER_PAYOUT");
  assert.equal(ledger.owedTo("p1").totalVnd, 90_000);
  ledger.markPaid(payout.id, "owner", null, AFTER_WINDOW);
  assert.equal(ledger.owedTo("p1").totalVnd, 0);
  assert.equal(ledger.pendingPayouts(AFTER_WINDOW + HOUR).length, 0);
});

test("fee income cannot be 'paid' again and unknown rows are reported", () => {
  const b = completedAt();
  const fee = ledgerRows(b.id).find((r) => r.kind === "FEE_INCOME");
  assert.equal(ledger.markPaid(fee.id, "owner", null, AFTER_WINDOW).alreadyPaid, true);
  assert.equal(code(() => ledger.markPaid(9999, "owner", null, NOW)), "NOT_FOUND");
});

test("refunds are never held, and are listed oldest first with who to pay", () => {
  makeCustomer("c2");
  const a = confirmed({ customerId: "c1" });
  bk.cancel(a.id, customer, START - 48 * HOUR);
  const b = confirmed({ customerId: "c2", startAt: START + 3 * HOUR });
  bk.cancel(b.id, { role: "customer", userId: "c2" }, START - 48 * HOUR);
  const list = ledger.pendingRefunds();
  assert.deepEqual(list.map((r) => [r.party_user_id, r.amount_vnd]), [["c1", 100_000], ["c2", 100_000]]);
  const refund = ledgerRows(a.id)[0];
  assert.equal(code(() => ledger.markPaid(refund.id, "owner", "hoàn tiền", START - 47 * HOUR)), "no error", "no waiting for refunds");
  assert.equal(ledger.pendingRefunds().length, 1);
  assert.equal(ledger.owedTo("c2").refundVnd, 100_000);
  assert.equal(ledger.owedTo("c1").refundVnd, 0);
});

test("owedTo adds payouts and refunds for one person and ignores everyone else", () => {
  completedAt();
  const b2 = completedAt({ startAt: START + 3 * HOUR });
  assert.equal(ledger.owedTo("p1").payoutVnd, 180_000);
  assert.equal(ledger.owedTo("p1").rows.length, 2);
  assert.equal(ledger.owedTo("c1").totalVnd, 0);
  assert.equal(ledger.owedTo("nobody").totalVnd, 0);
  assert.ok(b2);
});

test("nothing can be marked paid while its booking has an open dispute, and the payout leaves the pending list", () => {
  const b = completedAt();
  const { dispute } = bk.openDispute(b.id, customer, "x", START + 2 * HOUR);
  const payout = ledgerRows(b.id).find((r) => r.kind === "PLAYER_PAYOUT");
  assert.equal(ledger.pendingPayouts(AFTER_WINDOW + DAYS(5)).length, 0);
  assert.equal(code(() => ledger.markPaid(payout.id, "owner", null, AFTER_WINDOW + DAYS(5), { force: true })), "OPEN_DISPUTE");
  bk.resolveDispute(dispute.id, "pay_player", "staff1", "", START + 3 * HOUR);
  assert.equal(ledger.pendingPayouts(START + 4 * HOUR).length, 1, "a resolved dispute needs no further waiting");
  assert.equal(code(() => ledger.markPaid(payout.id, "owner", null, START + 4 * HOUR)), "no error");
});


test("a refund waits too while a dispute is open", () => {
  const b = completedAt();
  bk.openDispute(b.id, customer, "x", START + 2 * HOUR);
  assert.equal(ledger.pendingRefunds().length, 0);
});

test("the hold follows the review window in settings", () => {
  saveSettings({ reviewWindowHours: 48 });
  completedAt();
  assert.equal(ledger.pendingPayouts(AFTER_WINDOW).length, 0);
  assert.equal(ledger.pendingPayouts(START + HOUR + 48 * HOUR).length, 1);
});

test("summary totals by kind and status", () => {
  const a = completedAt();
  const payout = ledgerRows(a.id).find((r) => r.kind === "PLAYER_PAYOUT");
  makePlayer("p2");
  const c = confirmed({ playerId: "p2" });
  bk.noShow(c.id, "player", SYSTEM, START + 15 * MIN);
  assert.deepEqual(ledger.summary(), {
    payoutsOwed: { count: 1, vnd: 90_000 },
    payoutsPaid: { count: 0, vnd: 0 },
    refundsOwed: { count: 1, vnd: 100_000 },
    refundsPaid: { count: 0, vnd: 0 },
    tipsOwed: { count: 0, vnd: 0 },
    tipsPaid: { count: 0, vnd: 0 },
    feeIncome: { count: 1, vnd: 10_000 },
  });
  ledger.markPaid(payout.id, "owner", null, AFTER_WINDOW);
  const s = ledger.summary();
  assert.deepEqual(s.payoutsPaid, { count: 1, vnd: 90_000 });
  assert.deepEqual(s.payoutsOwed, { count: 0, vnd: 0 });
});

test("INVARIANT across many bookings: owed + paid + fee + refunds equals everything customers paid", () => {
  const paid = [];
  const players = ["p1", "p2", "p3"];
  makePlayer("p2");
  makePlayer("p3");
  let slot = 0;
  for (const who of players) {
    for (const name of ["completed", "noShowCustomer", "noShowPlayer", "cancelMiddle", "disputeSplit"]) {
      const b = confirmed({ playerId: who, startAt: START + (slot += 1) * 5 * HOUR });
      paths(b.id, b.start_at)[name]();
      paid.push(b);
    }
  }
  const s = ledger.summary();
  const everything = s.payoutsOwed.vnd + s.payoutsPaid.vnd + s.refundsOwed.vnd + s.refundsPaid.vnd + s.feeIncome.vnd;
  assert.equal(everything, paid.reduce((n, b) => n + b.price_vnd, 0));
  for (const b of paid) assertInvariant(b.id);
});
