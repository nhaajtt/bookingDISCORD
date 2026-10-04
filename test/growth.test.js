import { fresh, makePlayer, makeCustomer, book, confirmed, ledgerRows, sum, NOW, HOUR, DAY, MIN, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as bk from "../src/domain/bookings.js";
import * as ledger from "../src/domain/ledger.js";
import { quoteBooking } from "../src/domain/quoting.js";
import { getPlayer } from "../src/domain/players.js";
import { buyMembership, activeMembership } from "../src/domain/memberships.js";
import { referralCodeFor, useReferralCode, referralStats } from "../src/domain/referrals.js";
import { tipPlayer, tipFor } from "../src/domain/tips.js";
import { adjustWallet, walletBalance } from "../src/domain/wallet.js";
import { createCoupon } from "../src/domain/coupons.js";
import { getSettings, patchSettings } from "../src/settings.js";
import { upgradeLedgerForTest } from "../src/db.js";

const START = NOW + 3 * HOUR; // Monday 13:00 local
const { SYSTEM } = bk;
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
  makePlayer("p1", { rateVnd: 100_000 });
  makeCustomer("c1");
  makeCustomer("c2");
  makeCustomer("c3");
});

const quote = (opts = {}) => quoteBooking({ player: getPlayer("p1"), game: "Liên Quân", startAt: START, durationMin: 60, userId: "c1", now: NOW, ...opts });

// A booking that ran to the end, paid, so referral and tips have something to act on
function completedBooking({ customerId = "c1", durationMin = 120, startAt = START } = {}) {
  const b = book({ customerId, durationMin, startAt });
  bk.pay(b.id, NOW, b.price_vnd);
  bk.start(b.id, SYSTEM, b.start_at);
  return bk.complete(b.id, SYSTEM, b.start_at + durationMin * MIN);
}

test("quiet hours take a percent off the list price, out of the fee, and the player is paid the same", () => {
  patchSettings({ offpeak: [{ days: [1], startMin: 12 * 60, endMin: 16 * 60, percent: 10 }] });
  const q = quote();
  assert.equal(q.listPriceVnd, 100_000);
  assert.equal(q.discountVnd, 10_000);
  assert.equal(q.priceVnd, 90_000);
  assert.equal(q.feeVnd, 0, "the fee was 10 000 and all of it was given away");
  assert.equal(q.playerShareVnd, 90_000, "the player gets what they would have got without the discount");
});

test("the quiet-hour percent is capped at 50, and a slot outside the window is not discounted", () => {
  patchSettings({ offpeak: [{ days: [1], startMin: 0, endMin: 60, percent: 90 }] });
  assert.equal(getSettings().offpeak[0].percent, 50, "a percent above 50 is brought down to 50");
  assert.equal(quote().discountVnd, 0, "13:00 is outside the 00:00-01:00 window");
});

test("automatic discounts together never exceed the fee", () => {
  patchSettings({ offpeak: [{ days: [1], startMin: 0, endMin: 1440, percent: 50 }] });
  const q = quote();
  assert.equal(q.discountVnd, 10_000);
  assert.equal(q.feeVnd, 0);
  assert.equal(q.playerShareVnd, 90_000);
});

test("buying a membership takes the price from the wallet and discounts bookings until it ends", () => {
  patchSettings({ memberships: [{ id: "vip", name: "VIP", priceVnd: 100_000, days: 30, discountPercent: 5 }] });
  assert.equal(code(() => buyMembership("c1", "vip", NOW)), "WALLET_LOW");
  adjustWallet("c1", 150_000, "test", NOW);
  const { membership, balance } = buyMembership("c1", "vip", NOW);
  assert.equal(balance, 50_000);
  assert.equal(membership.expiresAt, NOW + 30 * DAY);
  assert.equal(activeMembership("c1", NOW + DAY).planName, "VIP");
  assert.equal(activeMembership("c1", NOW + 31 * DAY), null);
  const q = quote();
  assert.equal(q.memberDiscountVnd, 5_000);
  assert.equal(q.priceVnd, 95_000);
  assert.equal(quote({ userId: "c2" }).discountVnd, 0, "other people are not discounted");
  const b = book();
  assert.equal(b.price_vnd, 95_000);
  assert.equal(b.discount_vnd, 5_000);
});

test("renewing early extends from the end of the running membership", () => {
  patchSettings({ memberships: [{ id: "vip", name: "VIP", priceVnd: 50_000, days: 10, discountPercent: 5 }] });
  adjustWallet("c1", 200_000, "test", NOW);
  buyMembership("c1", "vip", NOW);
  const again = buyMembership("c1", "vip", NOW + 2 * DAY).membership;
  assert.equal(again.startedAt, NOW + 10 * DAY);
  assert.equal(again.expiresAt, NOW + 20 * DAY);
  assert.equal(walletBalance("c1"), 100_000);
});

test("a member discount and a coupon share the fee and the player's share never drops", () => {
  patchSettings({ memberships: [{ id: "vip", name: "VIP", priceVnd: 10_000, days: 30, discountPercent: 6 }] });
  adjustWallet("c1", 50_000, "test", NOW);
  buyMembership("c1", "vip", NOW);
  createCoupon({ code: "BIG", kind: "PERCENT", value: 50 }, NOW);
  const q = quote({ couponCode: "BIG" });
  assert.equal(q.autoDiscountVnd, 6_000);
  assert.equal(q.couponDiscountVnd, 4_000, "the coupon can only take what the member discount left of the fee");
  assert.equal(q.feeVnd, 0);
  assert.equal(q.playerShareVnd, 90_000);
  const b = book({ couponCode: "BIG" });
  assert.equal(b.discount_vnd, 10_000);
  assert.equal(getDb().prepare("SELECT discount_vnd FROM coupon_uses WHERE booking_id = ?").get(b.id).discount_vnd, 4_000, "the coupon report counts only the coupon's part");
});

test("referral: both sides are paid once, after the first completed session worth enough", () => {
  patchSettings({ referral: { rewardVnd: 10_000, minPriceVnd: 100_000 } });
  const link = referralCodeFor("c1", NOW);
  assert.equal(referralCodeFor("c1", NOW + 1), link, "one stable code per person");
  assert.match(link, /^[A-Z2-9]{6}$/);
  assert.equal(code(() => useReferralCode("c1", link, NOW)), "INVALID_INPUT", "not your own code");
  assert.equal(code(() => useReferralCode("c2", "NOPE00", NOW)), "INVALID_INPUT");
  useReferralCode("c2", link.toLowerCase(), NOW);
  assert.equal(code(() => useReferralCode("c2", link, NOW)), "INVALID_INPUT", "one code per newcomer");
  assert.equal(walletBalance("c1"), 0);
  completedBooking({ customerId: "c2" });
  assert.equal(walletBalance("c1"), 10_000);
  assert.equal(walletBalance("c2"), 10_000);
  assert.equal(referralStats("c1").rewarded, 1);
  completedBooking({ customerId: "c2", startAt: START + 5 * HOUR });
  assert.equal(walletBalance("c1"), 10_000, "only the first session pays");
});

test("referral: a first session below the minimum pays nothing, and a code is refused after the first booking", () => {
  patchSettings({ referral: { rewardVnd: 10_000, minPriceVnd: 150_000 } });
  const link = referralCodeFor("c1", NOW);
  useReferralCode("c2", link, NOW);
  completedBooking({ customerId: "c2", durationMin: 60 });
  assert.equal(walletBalance("c1"), 0);
  confirmed({ customerId: "c3", startAt: START + 8 * HOUR });
  assert.equal(code(() => useReferralCode("c3", link, NOW)), "INVALID_INPUT", "already booked");
});

test("referral can be switched off", () => {
  patchSettings({ referral: { rewardVnd: 0 } });
  assert.equal(code(() => useReferralCode("c2", referralCodeFor("c1", NOW), NOW)), "INVALID_INPUT");
});

test("a tip goes to the player in full, with no fee, once per completed booking", () => {
  const done = completedBooking();
  adjustWallet("c1", 100_000, "test", NOW);
  assert.equal(code(() => tipPlayer(done.id, "c2", 10_000, NOW)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => tipPlayer(done.id, "c1", 10_500, NOW)), "INVALID_INPUT");
  const { tip, balance } = tipPlayer(done.id, "c1", 20_000, NOW);
  assert.equal(tip.kind, "TIP");
  assert.equal(tip.party_user_id, "p1");
  assert.equal(tip.amount_vnd, 20_000);
  assert.equal(balance, 80_000);
  assert.equal(code(() => tipPlayer(done.id, "c1", 10_000, NOW)), "INVALID_INPUT", "one tip per booking");
  assert.equal(ledger.rowsFor(done.id).some((r) => r.kind === "TIP"), false, "the tip is not part of the booking's own sum");
  assert.equal(sum(ledger.rowsFor(done.id)), done.price_vnd);
});

test("a tip needs a completed booking, enough wallet and a recent session", () => {
  const open = confirmed();
  adjustWallet("c1", 5_000, "test", NOW);
  assert.equal(code(() => tipPlayer(open.id, "c1", 5_000, NOW)), "INVALID_INPUT", "not finished yet");
  const done = completedBooking({ startAt: START + 4 * HOUR });
  assert.equal(code(() => tipPlayer(done.id, "c1", 10_000, NOW)), "WALLET_LOW");
  adjustWallet("c1", 50_000, "test", NOW);
  assert.equal(code(() => tipPlayer(done.id, "c1", 10_000, NOW + 10 * DAY)), "TOO_LATE");
});

test("tips appear in the owner's payout queue at once and can be marked paid", () => {
  const done = completedBooking();
  adjustWallet("c1", 50_000, "test", NOW);
  tipPlayer(done.id, "c1", 10_000, NOW);
  const t = done.ended_at + 1000;
  const tipRow = ledger.pendingPayouts(t, { settings: getSettings() }).find((r) => r.kind === "TIP");
  assert.ok(tipRow, "the tip is payable now, with no complaint window");
  assert.ok(ledger.owedTo("p1").payoutVnd >= 10_000);
  assert.equal(ledger.summary().tipsOwed.vnd, 10_000);
  ledger.markPaid(tipRow.id, "owner", null, t);
  assert.equal(ledger.summary().tipsPaid.vnd, 10_000);
});

test("a dispute that rewrites the booking's money leaves the tip alone", () => {
  const done = completedBooking();
  adjustWallet("c1", 50_000, "test", NOW);
  tipPlayer(done.id, "c1", 10_000, NOW);
  ledger.settleBooking(done.id, 20_000, NOW, { replace: true });
  assert.equal(tipFor(done.id).amount_vnd, 10_000);
  assert.equal(sum(ledger.rowsFor(done.id)), done.price_vnd);
});

test("an old database with the three-kind ledger is rebuilt in place and keeps its rows", () => {
  const done = completedBooking();
  const db = getDb();
  const rows = db.prepare("SELECT * FROM ledger").all();
  db.exec("DROP TABLE ledger");
  db.exec("CREATE TABLE ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('PLAYER_PAYOUT','REFUND','FEE_INCOME')), party_user_id TEXT, amount_vnd INTEGER NOT NULL CHECK (amount_vnd >= 0), status TEXT NOT NULL CHECK (status IN ('OWED','PAID')), created_at INTEGER NOT NULL, paid_at INTEGER, paid_by TEXT, note TEXT)");
  for (const r of rows) {
    db.prepare("INSERT INTO ledger (id, booking_id, kind, party_user_id, amount_vnd, status, created_at, paid_at, paid_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(r.id, r.booking_id, r.kind, r.party_user_id, r.amount_vnd, r.status, r.created_at, r.paid_at, r.paid_by, r.note);
  }
  assert.ok(rows.length >= 2);
  upgradeLedgerForTest(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger").get().n, rows.length);
  assert.equal(sum(ledgerRows(done.id)), done.price_vnd);
  db.prepare("INSERT INTO ledger (booking_id, kind, party_user_id, amount_vnd, status, created_at) VALUES (?, 'TIP', 'p1', 5000, 'OWED', ?)").run(done.id, NOW);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ledger_once'").get(), "the indexes are back");
});

test("a gift card moves money from one wallet to another once, and never to its buyer", async () => {
  const { buyGiftCard, redeemGiftCard, unusedGiftCards } = await import("../src/domain/giftcards.js");
  adjustWallet("c1", 100_000, "test", NOW);
  assert.equal(code(() => buyGiftCard("c1", 500, NOW)), "INVALID_INPUT");
  assert.equal(code(() => buyGiftCard("c2", 50_000, NOW)), "WALLET_LOW");
  const card = buyGiftCard("c1", 60_000, NOW);
  assert.match(card.code, /^GC-[A-Z2-9]{8}$/);
  assert.equal(walletBalance("c1"), 40_000);
  assert.equal(unusedGiftCards("c1").length, 1);
  assert.equal(code(() => redeemGiftCard("c1", card.code, NOW)), "INVALID_INPUT", "not by the buyer");
  assert.equal(code(() => redeemGiftCard("c2", "GC-WRONG123", NOW)), "INVALID_INPUT");
  const done = redeemGiftCard("c2", card.code.toLowerCase().replace("-", " "), NOW);
  assert.equal(done.balance, 60_000);
  assert.equal(code(() => redeemGiftCard("c3", card.code, NOW)), "INVALID_INPUT", "single use");
  assert.equal(unusedGiftCards("c1").length, 0);
  assert.equal(walletBalance("c1") + walletBalance("c2"), 100_000, "no money was made or lost");
});

test("recommendations favour the games a customer booked, players they liked, and skip the ones they rated low", async () => {
  const { recommendFor } = await import("../src/domain/recommend.js");
  makePlayer("p2", { games: ["LoL"], rateVnd: 80_000 });
  makePlayer("p3", { games: ["Liên Quân"], rateVnd: 90_000 });
  const done = completedBooking({ customerId: "c1" });
  getDb().prepare("UPDATE bookings SET rating = 5 WHERE id = ?").run(done.id);
  const picks = recommendFor("c1", NOW + DAY);
  assert.equal(picks[0].userId, "p1", "the player they rated 5 comes first");
  assert.ok(picks[0].reasons.some((r) => /chấm cao/.test(r)));
  assert.ok(picks.findIndex((p) => p.userId === "p3") < picks.findIndex((p) => p.userId === "p2"), "same game before another game");
  assert.ok(!recommendFor("p1", NOW + DAY).some((p) => p.userId === "p1"), "never yourself");
  getDb().prepare("UPDATE bookings SET rating = 1 WHERE id = ?").run(done.id);
  assert.ok(!recommendFor("c1", NOW + DAY).some((p) => p.userId === "p1"), "a player rated 1 star is left out");
});
