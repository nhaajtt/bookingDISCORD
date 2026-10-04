import { NOW, HOUR, MIN, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, getDb, fresh } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cancel, actorFor, getBooking, noShow, openDispute, resolveDispute, pay, SYSTEM } from "../src/domain/bookings.js";
import { creditTopup, payFromWallet, walletBalance, adjustWallet, payExtensionFromWallet } from "../src/domain/wallet.js";
import { pendingRefunds } from "../src/domain/ledger.js";

beforeEach(() => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
  makeCustomer("c2");
});

test("a player no-show on a wallet-paid booking can still be resolved in the player's favour; the wallet refund is taken back", () => {
  creditTopup(1, "c1", 500_000, 0, NOW);
  const b = book({ customerId: "c1", playerId: "p1", startAt: NOW + 2 * HOUR });
  payFromWallet(b.id, "c1", NOW);
  noShow(b.id, "player", SYSTEM, NOW + 2 * HOUR + 20 * MIN);
  assert.equal(walletBalance("c1"), 500_000);
  const { dispute } = openDispute(b.id, { role: "player", userId: "p1" }, "i was there", NOW + 3 * HOUR);
  resolveDispute(dispute.id, "pay_player", "staff", "", NOW + 4 * HOUR);
  assert.equal(walletBalance("c1"), 400_000, "the customer keeps only what was not paid to the player");
  const rows = ledgerRows(b.id);
  assert.equal(sum(rows), 100_000);
  assert.equal(rows.find((r) => r.kind === "PLAYER_PAYOUT").amount_vnd, 90_000);
  assert.equal(pendingRefunds().length, 0);
});

test("a split resolution gives half back to the wallet once, and a spent wallet refuses the reversal", () => {
  creditTopup(1, "c1", 100_000, 0, NOW);
  const b = book({ customerId: "c1", playerId: "p1", startAt: NOW + 2 * HOUR });
  payFromWallet(b.id, "c1", NOW);
  noShow(b.id, "player", SYSTEM, NOW + 2 * HOUR + 20 * MIN);
  const { dispute } = openDispute(b.id, { role: "player", userId: "p1" }, "x", NOW + 3 * HOUR);
  adjustWallet("c1", -100_000, "spent elsewhere", NOW + 3 * HOUR + MIN);
  assert.throws(() => resolveDispute(dispute.id, "split", "staff", "", NOW + 4 * HOUR, { percent: 50 }), /đã được trả/);
  adjustWallet("c1", 100_000, "back", NOW + 4 * HOUR);
  resolveDispute(dispute.id, "split", "staff", "", NOW + 5 * HOUR, { percent: 50 });
  assert.equal(walletBalance("c1"), 50_000);
  assert.equal(sum(ledgerRows(b.id)), 100_000);
});

test("a payment after the window does not confirm a slot that someone else now holds; it is refunded as a late payment", () => {
  const a = book({ customerId: "c1", playerId: "p1", startAt: NOW + 5 * HOUR });
  const later = NOW + 31 * MIN;
  const other = book({ customerId: "c2", playerId: "p1", startAt: NOW + 5 * HOUR, now: later });
  const result = pay(a.id, later, a.price_vnd);
  assert.equal(result.late, true);
  assert.equal(getBooking(a.id).status, "EXPIRED");
  assert.equal(ledgerRows(a.id)[0].kind, "REFUND");
  assert.equal(getBooking(other.id).status, "AWAITING_PAYMENT");
  // with nobody in the way a slightly late payment still confirms
  const solo = book({ customerId: "c1", playerId: "p1", startAt: NOW + 9 * HOUR });
  assert.equal(pay(solo.id, NOW + 31 * MIN, solo.price_vnd).late, false);
});

test("the wallet cannot pay after the window, and a link-paid booking cannot be extended from the wallet", () => {
  creditTopup(1, "c1", 300_000, 0, NOW);
  const a = book({ customerId: "c1", playerId: "p1", startAt: NOW + 5 * HOUR });
  assert.throws(() => payFromWallet(a.id, "c1", NOW + 31 * MIN), /quá thời hạn/);
  const b = confirmed({ customerId: "c1", playerId: "p1", startAt: NOW + 2 * HOUR });
  getDb().prepare("UPDATE bookings SET status = 'IN_PROGRESS' WHERE id = ?").run(b.id);
  assert.throws(() => payExtensionFromWallet(b.id, "c1", 30, NOW + 2 * HOUR + 10 * MIN), /không thanh toán bằng ví/);
  assert.equal(walletBalance("c1"), 300_000);
  assert.ok(cancel && actorFor);
});
