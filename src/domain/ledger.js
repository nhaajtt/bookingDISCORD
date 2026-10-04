import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { HOUR } from "./time.js";

// The ledger is the honest record of what the owner must hand over by hand: PLAYER_PAYOUT rows (to players) and REFUND rows (to
// customers). The bot never holds money. FEE_INCOME rows are the owner's own share; they are born PAID because there is nothing to hand over.
//
// Rule for every booking: the rows always add up to exactly the amount the customer paid.
//   refund R (0..price)        -> REFUND = R
//   kept K = price - R         -> FEE_INCOME = floor(fee * K / price), PLAYER_PAYOUT = K - FEE_INCOME
// so a full refund keeps no fee, no refund keeps exactly the quoted fee, and a partial refund shares the kept part in the quoted proportion.
// One row per (booking, kind) is enforced by a unique index, so the same settlement can never be written twice.

export function planSettlement(priceVnd, feeVnd, refundVnd) {
  if (!Number.isInteger(refundVnd) || refundVnd < 0 || refundVnd > priceVnd) fail("INVALID_INPUT", { message: "Số tiền hoàn không hợp lệ." });
  const keptVnd = priceVnd - refundVnd;
  const feeKeptVnd = priceVnd === 0 ? 0 : Math.floor((feeVnd * keptVnd) / priceVnd);
  return { refundVnd, feeKeptVnd, payoutVnd: keptVnd - feeKeptVnd };
}

function bookingRow(bookingId) {
  const booking = getDb().prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  if (!booking) fail("NOT_FOUND", { what: "lịch" });
  return booking;
}

export function rowsFor(bookingId) {
  return getDb().prepare("SELECT * FROM ledger WHERE booking_id = ? ORDER BY id").all(bookingId);
}

function desiredRows(booking, plan, now, note) {
  const rows = [];
  // A booking paid from the wallet is refunded into the wallet at once, so there is nothing for the owner to transfer
  if (plan.refundVnd > 0) rows.push({ kind: "REFUND", party: booking.customer_id, amount: plan.refundVnd, status: booking.paid_with === "WALLET" ? "PAID" : "OWED", by: booking.paid_with === "WALLET" ? "wallet" : null });
  if (plan.feeKeptVnd > 0) rows.push({ kind: "FEE_INCOME", party: null, amount: plan.feeKeptVnd, status: "PAID" });
  if (plan.payoutVnd > 0) rows.push({ kind: "PLAYER_PAYOUT", party: booking.player_id, amount: plan.payoutVnd, status: "OWED" });
  return rows.map((r) => ({ ...r, now, note }));
}

function insert(bookingId, rows) {
  const stmt = getDb().prepare(
    "INSERT OR IGNORE INTO ledger (booking_id, kind, party_user_id, amount_vnd, status, created_at, paid_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) stmt.run(bookingId, r.kind, r.party, r.amount, r.status, r.now, r.status === "PAID" ? r.now : null, r.note ?? null);
  const booking = getDb().prepare("SELECT customer_id, paid_with FROM bookings WHERE id = ?").get(bookingId);
  if (booking?.paid_with === "WALLET") {
    for (const r of rows.filter((x) => x.kind === "REFUND")) {
      getDb()
        .prepare("INSERT OR IGNORE INTO wallet_tx (user_id, amount_vnd, kind, booking_id, note, created_at) VALUES (?, ?, 'REFUND', ?, ?, ?)")
        .run(booking.customer_id, r.amount, bookingId, `hoàn lịch #${bookingId}`, r.now);
    }
    getDb().prepare("UPDATE ledger SET paid_by = 'wallet' WHERE booking_id = ? AND kind = 'REFUND' AND status = 'PAID' AND paid_by IS NULL").run(bookingId);
  }
}

// settleBooking(bookingId, refundVnd, now, { replace?, note? }) -> { created, rows }
// Writes the rows for the booking's money. If the booking already has rows nothing is written (idempotent), unless `replace` is set,
// which is what dispute resolution uses: then the old rows are swapped for the new plan, but only while nothing was handed over yet.
export function settleBooking(bookingId, refundVnd, now = Date.now(), { replace = false, note = null } = {}) {
  return transaction(() => {
    const booking = bookingRow(bookingId);
    const plan = planSettlement(booking.price_vnd, booking.fee_vnd, refundVnd);
    const existing = rowsFor(bookingId);
    const wanted = desiredRows(booking, plan, now, note);
    if (existing.length && !replace) return { created: false, rows: existing };
    if (existing.length) {
      const same = existing.length === wanted.length && wanted.every((w) => existing.some((e) => e.kind === w.kind && e.amount_vnd === w.amount));
      if (same) return { created: false, rows: existing };
      const handedOver = existing.filter((e) => e.kind !== "FEE_INCOME" && e.status === "PAID");
      // Money returned to the wallet never left the owner's hands, so it can be taken back, as long as the customer still has it
      const walletRefund = handedOver.find((e) => e.kind === "REFUND" && e.paid_by === "wallet");
      if (handedOver.some((e) => e !== walletRefund)) fail("SETTLED_ALREADY");
      if (walletRefund) {
        const db = getDb();
        const balance = Number(db.prepare("SELECT COALESCE(SUM(amount_vnd), 0) AS v FROM wallet_tx WHERE user_id = ?").get(booking.customer_id).v);
        if (balance < walletRefund.amount_vnd) fail("SETTLED_ALREADY");
        db.prepare("UPDATE wallet_tx SET kind = 'ADJUST', note = ? WHERE kind = 'REFUND' AND booking_id = ?").run(`hoàn lịch #${bookingId} đã đảo lại`, bookingId);
        db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'ADJUST', ?, ?)").run(booking.customer_id, -walletRefund.amount_vnd, `đảo hoàn lịch #${bookingId}`, now);
      }
      getDb().prepare("DELETE FROM ledger WHERE booking_id = ?").run(bookingId);
    }
    insert(bookingId, wanted);
    getDb().prepare("UPDATE bookings SET refund_due_vnd = ? WHERE id = ?").run(plan.refundVnd, bookingId);
    return { created: true, rows: rowsFor(bookingId) };
  });
}

// Money that arrived for a booking that can no longer take it (expired or cancelled before it was paid): refund it all, once
export function refundLatePayment(bookingId, amountVnd, now = Date.now(), note = "thanh toán muộn") {
  return transaction(() => {
    const booking = bookingRow(bookingId);
    if (rowsFor(bookingId).length) return { created: false, rows: rowsFor(bookingId) };
    insert(bookingId, [{ kind: "REFUND", party: booking.customer_id, amount: amountVnd, status: "OWED", now, note }]);
    getDb().prepare("UPDATE bookings SET refund_due_vnd = ? WHERE id = ?").run(amountVnd, bookingId);
    return { created: true, rows: rowsFor(bookingId) };
  });
}

// When a payout may be handed over: the review and dispute window after the session ended must have passed
export function payoutReleaseAt(booking, settings = getSettings()) {
  // Staff already decided a resolved dispute, so there is nothing left to wait for (open disputes are blocked separately)
  if ((booking.booking_status ?? booking.status) === "DISPUTED") return 0;
  const ended = booking.ended_at ?? booking.start_at + booking.duration_min * 60_000;
  return ended + settings.reviewWindowHours * HOUR;
}

const joined = `SELECT l.*, b.start_at, b.ended_at, b.duration_min, b.status AS booking_status, b.game, b.customer_id, b.player_id,
  EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = l.booking_id AND d.status = 'OPEN') AS disputed
  FROM ledger l JOIN bookings b ON b.id = l.booking_id`;

// One ledger row with its booking, or null
export function getLedgerRow(ledgerId) {
  return getDb().prepare(`${joined} WHERE l.id = ?`).get(ledgerId) ?? null;
}

// What one person is owed right now (payouts and refunds still OWED), including amounts that are still on hold
export function owedTo(userId) {
  const rows = getDb().prepare(`${joined} WHERE l.party_user_id = ? AND l.status = 'OWED' ORDER BY l.id`).all(userId);
  const sum = (kind) => rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.amount_vnd, 0);
  return { userId, payoutVnd: sum("PLAYER_PAYOUT"), refundVnd: sum("REFUND"), totalVnd: sum("PLAYER_PAYOUT") + sum("REFUND"), rows };
}

// Refunds the owner still has to send to customers, oldest first. Refunds are never held back.
export function pendingRefunds() {
  return getDb().prepare(`${joined} WHERE l.kind = 'REFUND' AND l.status = 'OWED' AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.booking_id = l.booking_id AND d.status = 'OPEN') ORDER BY l.id`).all();
}

// Payouts the owner may send now: OWED, no open dispute, and the hold has passed. { includeHeld: true } also returns the held ones, each with releaseAt.
export function pendingPayouts(now = Date.now(), { includeHeld = false, settings = getSettings() } = {}) {
  return getDb()
    .prepare(`${joined} WHERE l.kind = 'PLAYER_PAYOUT' AND l.status = 'OWED' ORDER BY l.id`)
    .all()
    .map((r) => ({ ...r, releaseAt: payoutReleaseAt(r, settings) }))
    .filter((r) => !r.disputed && (includeHeld || r.releaseAt <= now));
}

// markPaid(ledgerId, by, note, now, { force? }) -> { row, alreadyPaid }
// Marks a row as handed over. Calling it again changes nothing and says so. A payout cannot be marked while its hold runs (unless
// forced) or while the booking has an open dispute.
export function markPaid(ledgerId, by, note = null, now = Date.now(), { force = false, settings = getSettings() } = {}) {
  return transaction(() => {
    const r = getDb().prepare(`${joined} WHERE l.id = ?`).get(ledgerId);
    if (!r) fail("NOT_FOUND", { what: "khoản tiền" });
    if (r.status === "PAID") return { row: r, alreadyPaid: true };
    if (r.disputed) fail("OPEN_DISPUTE");
    if (r.kind === "PLAYER_PAYOUT" && !force && payoutReleaseAt(r, settings) > now) fail("PAYOUT_HELD");
    const changed = Number(
      getDb().prepare("UPDATE ledger SET status = 'PAID', paid_at = ?, paid_by = ?, note = COALESCE(?, note) WHERE id = ? AND status = 'OWED'").run(now, by ?? null, note, ledgerId).changes,
    );
    return { row: getDb().prepare("SELECT * FROM ledger WHERE id = ?").get(ledgerId), alreadyPaid: changed === 0 };
  });
}

// Totals by kind and status, the numbers the owner reconciles against the bank
export function summary() {
  const rows = getDb().prepare("SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(amount_vnd), 0) AS total FROM ledger GROUP BY kind, status").all();
  const get = (kind, status) => rows.find((r) => r.kind === kind && r.status === status) ?? { n: 0, total: 0 };
  return {
    payoutsOwed: { count: get("PLAYER_PAYOUT", "OWED").n, vnd: get("PLAYER_PAYOUT", "OWED").total },
    payoutsPaid: { count: get("PLAYER_PAYOUT", "PAID").n, vnd: get("PLAYER_PAYOUT", "PAID").total },
    refundsOwed: { count: get("REFUND", "OWED").n, vnd: get("REFUND", "OWED").total },
    refundsPaid: { count: get("REFUND", "PAID").n, vnd: get("REFUND", "PAID").total },
    feeIncome: { count: get("FEE_INCOME", "PAID").n, vnd: get("FEE_INCOME", "PAID").total },
  };
}

// The check every settlement test relies on: for a booking, rows add up to `expectedVnd` and nothing is negative or duplicated
export function checkBookingLedger(bookingId, expectedVnd) {
  const rows = rowsFor(bookingId);
  const total = rows.reduce((n, r) => n + r.amount_vnd, 0);
  const kinds = new Set(rows.map((r) => r.kind));
  return { ok: total === expectedVnd && rows.every((r) => r.amount_vnd >= 0) && kinds.size === rows.length, total, rows };
}
