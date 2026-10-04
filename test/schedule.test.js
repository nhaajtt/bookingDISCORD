import { fresh, makePlayer, makeCustomer, book, confirmed, NOW, HOUR, MIN, DAY } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as bk from "../src/domain/bookings.js";
import { dueActions, loadScheduleState, markActionDone, FLAG_ACTIONS } from "../src/domain/schedule.js";
import { recordRating } from "../src/domain/ratings.js";
import { saveSettings } from "../src/settings.js";

const { SYSTEM } = bk;
const START = NOW + 2 * DAY + 3 * HOUR; // Wednesday 13:00
const END = START + HOUR;

beforeEach(() => {
  fresh();
  makePlayer("p1");
  makeCustomer("c1");
});

const due = (now, voice = {}) => dueActions(loadScheduleState(now, voice), now);
const types = (list) => list.map((a) => a.type);
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return "no error";
};

// ---------------------------------------------------------------- reminders

test("nothing is due for a confirmed booking that is far away", () => {
  confirmed({ startAt: START });
  assert.deepEqual(due(NOW + HOUR), []);
});

test("the 24 hour reminder is due from 24 hours before the start, once", () => {
  const b = confirmed({ startAt: START });
  assert.deepEqual(due(START - 24 * HOUR - 1), []);
  assert.deepEqual(due(START - 24 * HOUR), [{ type: "reminder24h", bookingId: b.id }]);
  assert.equal(markActionDone(b.id, "reminder24h", START - 24 * HOUR), true);
  assert.deepEqual(due(START - 24 * HOUR + MIN), []);
  assert.equal(markActionDone(b.id, "reminder24h", START - 23 * HOUR), false, "already recorded");
  assert.equal(bk.getBooking(b.id).reminders_sent.reminder24h, START - 24 * HOUR, "the first timestamp stays");
});

test("the 1 hour and 10 minute reminders each fire once, in their own window", () => {
  const b = confirmed({ startAt: START });
  markActionDone(b.id, "reminder24h", NOW);
  assert.deepEqual(types(due(START - HOUR)), ["reminder1h"]);
  markActionDone(b.id, "reminder1h", START - HOUR);
  assert.deepEqual(due(START - HOUR + MIN), []);
  assert.deepEqual(types(due(START - 10 * MIN)), ["reminder10m", "openRooms"]);
  markActionDone(b.id, "reminder10m", START - 10 * MIN);
  assert.deepEqual(types(due(START - 9 * MIN)), ["openRooms"]);
});

test("a stale reminder is not sent late: once the 1 hour mark is reached the 24 hour one is dropped", () => {
  confirmed({ startAt: START });
  assert.deepEqual(types(due(START - HOUR)), ["reminder1h"]);
  assert.deepEqual(types(due(START - 30 * MIN)), ["reminder1h"]);
  assert.ok(!types(due(START - 9 * MIN)).includes("reminder1h"), "past 10 minutes the 1 hour reminder is stale too");
});

test("no reminder is sent for a moment that came before the booking was confirmed", () => {
  const b = book({ startAt: START });
  bk.pay(b.id, START - 30 * MIN, b.price_vnd);
  assert.deepEqual(due(START - 29 * MIN), []);
  assert.deepEqual(types(due(START - 10 * MIN)), ["reminder10m", "openRooms"]);
});

test("paid five minutes before the start: no reminders at all, just the rooms", () => {
  const b = book({ startAt: START });
  bk.pay(b.id, START - 5 * MIN, b.price_vnd);
  assert.deepEqual(types(due(START - 5 * MIN)), ["openRooms"]);
});

test("reminders are only for confirmed bookings", () => {
  const b = book({ startAt: START });
  assert.deepEqual(due(START - 24 * HOUR).filter((a) => a.bookingId === b.id && a.type.startsWith("reminder")), []);
  bk.pay(b.id, NOW, b.price_vnd);
  bk.cancel(b.id, { role: "customer", userId: "c1" }, NOW + MIN);
  assert.deepEqual(due(START - 24 * HOUR), []);
});

test("a booking confirmed long ago still gets all three reminders over time", () => {
  const b = confirmed({ startAt: START });
  const seen = [];
  for (let t = START - 26 * HOUR; t < START; t += 5 * MIN) {
    for (const a of due(t).filter((x) => x.type.startsWith("reminder"))) {
      seen.push(a.type);
      markActionDone(b.id, a.type, t);
    }
  }
  assert.deepEqual(seen, ["reminder24h", "reminder1h", "reminder10m"]);
});

// ---------------------------------------------------------------- rooms, start, no-show, end

test("rooms open 10 minutes before the start for confirmed bookings, until the end, once", () => {
  const b = confirmed({ startAt: START });
  assert.ok(!types(due(START - 11 * MIN)).includes("openRooms"));
  assert.ok(types(due(START - 10 * MIN)).includes("openRooms"));
  assert.ok(types(due(START + 30 * MIN)).includes("openRooms"), "still due if the bot was down at 10 minutes before");
  assert.ok(!types(due(END)).includes("openRooms"));
  bk.setRooms(b.id, "t1", "v1", START - 10 * MIN);
  assert.ok(!types(due(START - 9 * MIN)).includes("openRooms"));
});

test("start is due when both are in the voice room at or after the start time", () => {
  const b = confirmed({ startAt: START });
  const both = { [b.id]: ["c1", "p1"] };
  assert.ok(!types(due(START - MIN, both)).includes("start"), "not before the start time");
  assert.ok(types(due(START, both)).includes("start"));
  assert.ok(!types(due(START, { [b.id]: ["c1"] })).includes("start"));
  assert.ok(!types(due(START, { [b.id]: ["p1", "stranger"] })).includes("start"));
  assert.ok(!types(due(START, {})).includes("start"));
  assert.ok(!types(due(END, both)).includes("start"), "not once the session would be over");
});

test("noShowCheck is due 15 minutes after the start and says who is missing", () => {
  const b = confirmed({ startAt: START });
  const grace = START + 15 * MIN;
  assert.deepEqual(due(grace - 1, {}).filter((a) => a.type === "noShowCheck"), []);
  assert.deepEqual(due(grace, {}).filter((a) => a.type === "noShowCheck"), [{ type: "noShowCheck", bookingId: b.id, absent: "both" }]);
  assert.deepEqual(due(grace, { [b.id]: ["c1"] }).filter((a) => a.type === "noShowCheck"), [{ type: "noShowCheck", bookingId: b.id, absent: "player" }]);
  assert.deepEqual(due(grace, { [b.id]: ["p1"] }).filter((a) => a.type === "noShowCheck"), [{ type: "noShowCheck", bookingId: b.id, absent: "customer" }]);
  assert.deepEqual(due(grace, { [b.id]: ["p1", "c1"] }).filter((a) => a.type === "noShowCheck"), [], "both here: start, not no-show");
});

test("the grace comes from settings", () => {
  saveSettings({ noShowGraceMin: 30 });
  const b = confirmed({ startAt: START });
  assert.ok(!types(due(START + 29 * MIN)).includes("noShowCheck"));
  assert.ok(types(due(START + 30 * MIN)).includes("noShowCheck"));
  assert.ok(b);
});

test("autoEnd is due at start plus duration for a running session", () => {
  const b = confirmed({ startAt: START });
  bk.start(b.id, SYSTEM, START);
  assert.ok(!types(due(END - 1)).includes("autoEnd"));
  assert.deepEqual(due(END).filter((a) => a.type === "autoEnd"), [{ type: "autoEnd", bookingId: b.id }]);
  assert.ok(!types(due(END)).includes("noShowCheck"), "a running session is never a no-show");
});

test("expireUnpaid is due after the payment window", () => {
  const b = book({ startAt: START });
  assert.deepEqual(due(NOW + 30 * MIN - 1), []);
  assert.deepEqual(due(NOW + 30 * MIN), [{ type: "expireUnpaid", bookingId: b.id }]);
  bk.expireUnpaid(b.id, NOW + 30 * MIN);
  assert.deepEqual(due(NOW + 31 * MIN), []);
});

// ---------------------------------------------------------------- rating and rooms after the end

function completedBooking() {
  const b = confirmed({ startAt: START });
  bk.start(b.id, SYSTEM, START);
  bk.complete(b.id, SYSTEM, END);
  return b.id;
}

test("askRating is due right after completion, once, and not after a rating", () => {
  const id = completedBooking();
  assert.deepEqual(due(END).filter((a) => a.type === "askRating"), [{ type: "askRating", bookingId: id }]);
  markActionDone(id, "askRating", END);
  assert.deepEqual(due(END + HOUR), []);
  const other = (fresh(), makePlayer("p1"), makeCustomer("c1"), completedBooking());
  recordRating(other, "c1", 5, "", END + MIN);
  assert.deepEqual(due(END + 2 * MIN).filter((a) => a.type === "askRating"), []);
});

test("autoComplete is due once the review window passes with no rating, and askRating stops", () => {
  const id = completedBooking();
  const closes = END + 24 * HOUR;
  assert.ok(!types(due(closes - 1)).includes("autoComplete"));
  assert.ok(types(due(closes - 1)).includes("askRating"));
  const at = due(closes).filter((a) => a.bookingId === id).map((a) => a.type);
  assert.ok(at.includes("autoComplete"));
  assert.ok(!at.includes("askRating"));
  markActionDone(id, "autoComplete", closes);
  assert.ok(!types(due(closes + HOUR)).includes("autoComplete"));
});

test("a rated booking never gets autoComplete", () => {
  const id = completedBooking();
  recordRating(id, "c1", 4, "", END + HOUR);
  assert.deepEqual(due(END + 25 * HOUR).filter((a) => a.type === "autoComplete"), []);
});

test("closeRooms is due 15 minutes after a finished booking that has rooms, once", () => {
  const id = completedBooking();
  assert.ok(!types(due(END + 20 * MIN)).includes("closeRooms"), "no rooms, nothing to close");
  bk.setRooms(id, "t1", "v1", START - 10 * MIN);
  assert.ok(!types(due(END + 15 * MIN - 1)).includes("closeRooms"));
  assert.ok(types(due(END + 15 * MIN)).includes("closeRooms"));
  markActionDone(id, "closeRooms", END + 15 * MIN);
  assert.ok(!types(due(END + HOUR)).includes("closeRooms"));
});

test("rooms of a cancelled or no-show booking are closed too, but a disputed booking keeps them for staff", () => {
  const a = confirmed({ startAt: START });
  bk.setRooms(a.id, "t1", "v1", START - 10 * MIN);
  bk.noShow(a.id, "player", SYSTEM, START + 15 * MIN);
  makeCustomer("c2");
  const b = confirmed({ customerId: "c2", startAt: START + 3 * HOUR });
  bk.setRooms(b.id, "t2", "v2", START);
  bk.cancel(b.id, SYSTEM, START + 3 * HOUR - HOUR);
  makeCustomer("c3");
  const c = confirmed({ customerId: "c3", startAt: START + 6 * HOUR });
  bk.setRooms(c.id, "t3", "v3", START);
  bk.start(c.id, SYSTEM, c.start_at);
  bk.openDispute(c.id, { role: "customer", userId: "c3" }, "vấn đề", c.start_at + 10 * MIN);
  const list = due(START + 20 * HOUR).filter((x) => x.type === "closeRooms").map((x) => x.bookingId);
  assert.deepEqual(list, [a.id, b.id]);
});

// ---------------------------------------------------------------- general properties

test("the same state and time always give the same list, and the call changes nothing", () => {
  confirmed({ startAt: START });
  const state = loadScheduleState(START - 10 * MIN, {});
  const one = dueActions(state, START - 10 * MIN);
  const two = dueActions(state, START - 10 * MIN);
  assert.deepEqual(one, two);
  assert.deepEqual(dueActions(loadScheduleState(START - 10 * MIN, {}), START - 10 * MIN), one);
  assert.ok(one.length > 0);
});

test("actions come out ordered by booking and by a fixed order of types", () => {
  const a = confirmed({ startAt: START });
  makeCustomer("c2");
  const b = confirmed({ customerId: "c2", startAt: START + 2 * HOUR });
  const list = due(START - 10 * MIN);
  assert.deepEqual(list.map((x) => [x.bookingId, x.type]), [[a.id, "reminder10m"], [a.id, "openRooms"], [b.id, "reminder24h"]]);
});

test("only flag actions can be marked; unknown bookings are reported", () => {
  const b = confirmed({ startAt: START });
  assert.equal(code(() => markActionDone(b.id, "autoEnd", NOW)), "INVALID_INPUT");
  assert.equal(code(() => markActionDone(b.id, "bogus", NOW)), "INVALID_INPUT");
  assert.equal(code(() => markActionDone(999, "askRating", NOW)), "NOT_FOUND");
  for (const type of FLAG_ACTIONS) assert.ok(typeof markActionDone(b.id, type, NOW) === "boolean");
});

test("dueActions is pure: it accepts plain rows, JSON strings for flags, and no database", () => {
  const row = { id: 1, customer_id: "a", player_id: "b", start_at: START, duration_min: 60, status: "CONFIRMED", created_at: NOW, paid_at: NOW, ended_at: null, rating: null, text_channel_id: null, voice_channel_id: null, reminders_sent: "{}" };
  assert.deepEqual(types(dueActions({ bookings: [row] }, START - 24 * HOUR)), ["reminder24h"]);
  assert.deepEqual(types(dueActions({ bookings: [{ ...row, reminders_sent: '{"reminder24h":1}' }] }, START - 24 * HOUR)), []);
  assert.deepEqual(dueActions({ bookings: [] }, NOW), []);
  assert.deepEqual(dueActions({}, NOW), []);
});

// ---------------------------------------------------------------- end to end

// Runs the clock minute by minute and does what the Discord layer would do, counting how often each action ran
function simulate({ voiceAt, from, to }) {
  const ran = {};
  const note = (type) => (ran[type] = (ran[type] ?? 0) + 1);
  for (let t = from; t <= to; t += MIN) {
    const state = loadScheduleState(t, {});
    const voice = {};
    for (const b of state.bookings) voice[b.id] = voiceAt(b, t);
    for (const action of dueActions({ ...state, voice }, t)) {
      note(action.type);
      const id = action.bookingId;
      if (action.type === "expireUnpaid") bk.expireUnpaid(id, t);
      else if (action.type === "openRooms") bk.setRooms(id, `t${id}`, `v${id}`, t);
      else if (action.type === "start") bk.start(id, SYSTEM, t);
      else if (action.type === "autoEnd") bk.complete(id, SYSTEM, t);
      else if (action.type === "noShowCheck") {
        if (action.absent === "both") bk.cancel(id, SYSTEM, t, { reason: "cả hai vắng mặt" });
        else bk.noShow(id, action.absent, SYSTEM, t);
      } else assert.equal(markActionDone(id, action.type, t), true, `${action.type} must not be due twice`);
    }
  }
  return ran;
}

test("a normal booking runs through every action exactly once", () => {
  const b = confirmed({ startAt: START });
  const ran = simulate({ voiceAt: (x, t) => (t >= START + 2 * MIN && t < END ? [x.customer_id, x.player_id] : []), from: NOW, to: END + 2 * DAY });
  assert.deepEqual(ran, { reminder24h: 1, reminder1h: 1, openRooms: 1, reminder10m: 1, start: 1, autoEnd: 1, askRating: 1, autoComplete: 1, closeRooms: 1 });
  assert.equal(bk.getBooking(b.id).status, "COMPLETED");
});

test("a player who never shows up ends in a refund, a strike and closed rooms", () => {
  const b = confirmed({ startAt: START });
  const ran = simulate({ voiceAt: (x, t) => (t >= START ? [x.customer_id] : []), from: NOW, to: START + 2 * HOUR });
  assert.equal(ran.noShowCheck, 1);
  assert.equal(ran.start, undefined);
  assert.equal(ran.closeRooms, 1);
  assert.equal(bk.getBooking(b.id).status, "NO_SHOW_PLAYER");
  assert.equal(bk.getBooking(b.id).refund_due_vnd, b.price_vnd);
});

test("when nobody shows up the system cancels with a full refund and no strike", () => {
  const b = confirmed({ startAt: START });
  simulate({ voiceAt: () => [], from: NOW, to: START + 2 * HOUR });
  const done = bk.getBooking(b.id);
  assert.equal(done.status, "CANCELLED");
  assert.equal(done.cancelled_by, "system");
  assert.equal(done.refund_due_vnd, b.price_vnd);
});

test("an unpaid booking expires once and the rest of the schedule stays quiet", () => {
  book({ startAt: START });
  const ran = simulate({ voiceAt: () => [], from: NOW, to: NOW + 3 * DAY });
  assert.deepEqual(ran, { expireUnpaid: 1 });
});
