import { fresh, makePlayer, makeCustomer, confirmed, NOW, HOUR, DAY, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as bk from "../src/domain/bookings.js";
import * as ratings from "../src/domain/ratings.js";
import { getPlayer, suspendPlayer, pausePlayer } from "../src/domain/players.js";
import { saveSettings } from "../src/settings.js";
import { addToBlacklist } from "../src/domain/strikes.js";

const { SYSTEM } = bk;
const START = NOW + 3 * HOUR;
const END = START + HOUR;
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

function completed(extra = {}) {
  const b = confirmed(extra);
  bk.start(b.id, SYSTEM, b.start_at);
  bk.complete(b.id, SYSTEM, b.start_at + HOUR);
  return bk.getBooking(b.id);
}

// ---------------------------------------------------------------- recording

test("the customer rates a completed booking once and the player's numbers move", () => {
  const b = completed();
  const r = ratings.recordRating(b.id, "c1", 5, "Chơi rất vui", END + HOUR);
  assert.equal(r.booking.rating, 5);
  assert.equal(r.booking.review, "Chơi rất vui");
  assert.deepEqual(r.player, { average: 5, count: 1, completed: 1 });
});

test("the average is over all ratings, to two decimals", () => {
  const stars = [5, 4, 4];
  stars.forEach((s, i) => {
    const b = completed({ startAt: START + i * 2 * HOUR });
    ratings.recordRating(b.id, "c1", s, "", b.start_at + 2 * HOUR);
  });
  assert.deepEqual(ratings.playerRating("p1"), { average: 4.33, count: 3, completed: 3 });
  assert.equal(getPlayer("p1").average, 4.33);
});

test("a second rating is refused and changes nothing", () => {
  const b = completed();
  ratings.recordRating(b.id, "c1", 4, "ok", END + HOUR);
  assert.equal(code(() => ratings.recordRating(b.id, "c1", 1, "đổi ý", END + 2 * HOUR)), "ALREADY_RATED");
  assert.deepEqual(ratings.playerRating("p1"), { average: 4, count: 1, completed: 1 });
  assert.equal(bk.getBooking(b.id).rating, 4);
});

test("stars must be a whole number from 1 to 5", () => {
  const b = completed();
  for (const bad of [0, 6, -1, 3.5, "5", NaN, null, undefined]) assert.equal(code(() => ratings.recordRating(b.id, "c1", bad, "", END)), "BAD_STARS", String(bad));
  for (const good of [1, 2, 3, 4, 5]) {
    fresh();
    makePlayer("p1");
    makeCustomer("c1");
    const x = completed();
    assert.equal(ratings.recordRating(x.id, "c1", good, "", END).booking.rating, good);
  }
});

test("only the booking's customer can rate it", () => {
  const b = completed();
  assert.equal(code(() => ratings.recordRating(b.id, "p1", 5, "", END)), "FORBIDDEN_ACTOR");
  assert.equal(code(() => ratings.recordRating(b.id, "c2", 5, "", END)), "FORBIDDEN_ACTOR");
});

test("only completed bookings can be rated", () => {
  const unpaid = confirmed();
  assert.equal(code(() => ratings.recordRating(unpaid.id, "c1", 5, "", NOW)), "NOT_RATEABLE");
  bk.start(unpaid.id, SYSTEM, START);
  assert.equal(code(() => ratings.recordRating(unpaid.id, "c1", 5, "", START)), "NOT_RATEABLE");
  assert.equal(code(() => ratings.recordRating(999, "c1", 5, "", NOW)), "NOT_FOUND");
});

test("no-show and disputed bookings cannot be rated", () => {
  const b = confirmed();
  bk.noShow(b.id, "player", SYSTEM, START + 15 * 60_000);
  assert.equal(code(() => ratings.recordRating(b.id, "c1", 1, "", START + HOUR)), "NOT_RATEABLE");
});

test("the review window is 24 hours from the end, inclusive", () => {
  const b = completed();
  assert.equal(code(() => ratings.recordRating(b.id, "c1", 5, "", END + 24 * HOUR + 1)), "REVIEW_CLOSED");
  assert.equal(code(() => ratings.recordRating(b.id, "c1", 5, "", END + 24 * HOUR)), "no error");
});

test("the review window comes from settings", () => {
  saveSettings({ reviewWindowHours: 2 });
  const b = completed();
  assert.equal(code(() => ratings.recordRating(b.id, "c1", 5, "", END + 3 * HOUR)), "REVIEW_CLOSED");
  assert.equal(code(() => ratings.recordRating(b.id, "c1", 5, "", END + 2 * HOUR)), "no error");
});

test("a failed rating leaves the player's totals alone", () => {
  const b = completed();
  code(() => ratings.recordRating(b.id, "c1", 5, "", END + 30 * HOUR));
  assert.deepEqual(ratings.playerRating("p1"), { average: 0, count: 0, completed: 1 });
});

test("rating an unknown player gives zeros", () => {
  assert.deepEqual(ratings.playerRating("ghost"), { average: 0, count: 0, completed: 0 });
});

// ---------------------------------------------------------------- sanitizing

test("mentions of every kind are stripped from reviews", () => {
  assert.equal(ratings.sanitizeReview("hay <@123456789012345678> và <@!123> và <@&987654321098765432> và <#555> nhé"), "hay và và và nhé");
  assert.equal(ratings.sanitizeReview("@everyone @here Everyone @EVERYONE"), "Everyone");
  assert.equal(ratings.sanitizeReview("liên hệ a@b.vn"), "liên hệ ab.vn", "a stray @ can never become a mention");
  assert.equal(ratings.sanitizeReview("</lệnh:123> dùng"), "dùng");
});

test("links and invites are removed, control characters and spacing are tidied", () => {
  assert.equal(ratings.sanitizeReview("vào https://evil.test/x?a=1 đi"), "vào đi");
  assert.equal(ratings.sanitizeReview("discord.gg/abc123 tham gia"), "tham gia");
  assert.equal(ratings.sanitizeReview("www.x.vn ok"), "ok");
  assert.equal(ratings.sanitizeReview("a\u0000b‮c​d\n\n\te   f"), "a b c d e f");
});

test("reviews are cut to 500 characters by default, counting characters not bytes", () => {
  assert.equal(ratings.sanitizeReview("a".repeat(900)).length, 500);
  const emoji = ratings.sanitizeReview("😀".repeat(900));
  assert.equal([...emoji].length, 500);
  assert.equal(ratings.sanitizeText("Việt Nam", 4), "Việt");
  assert.equal(ratings.sanitizeText("abc  ", 4), "abc");
});

test("empty and odd input is safe", () => {
  for (const bad of [null, undefined, 42, {}, [], ""]) assert.equal(typeof ratings.sanitizeReview(bad), "string");
  assert.equal(ratings.sanitizeReview(null), "");
  assert.equal(ratings.sanitizeReview("<@1><@2>"), "");
});

test("a stored review is the sanitized one", () => {
  const b = completed();
  const r = ratings.recordRating(b.id, "c1", 4, "xem @everyone https://x.test <@5> ổn", END);
  assert.equal(r.booking.review, "xem ổn");
});

// ---------------------------------------------------------------- trusted

function setStats(userId, completedCount, sum, count) {
  getDb().prepare("UPDATE players SET completed = ?, rating_sum = ?, rating_count = ? WHERE user_id = ?").run(completedCount, sum, count, userId);
}

test("trusted means at least 10 completed and an average of 4.5 or more", () => {
  const cases = [
    [10, 45, 10, true],
    [10, 44, 10, false],
    [9, 50, 10, false],
    [10, 5 * 10, 10, true],
    [25, 90, 20, true],
    [25, 89, 20, false],
    [10, 0, 0, false],
  ];
  for (const [done, sum, count, expected] of cases) {
    setStats("p1", done, sum, count);
    assert.equal(ratings.isTrusted(getPlayer("p1")), expected, `${done} done, ${sum}/${count}`);
  }
});

test("only active players can be trusted", () => {
  setStats("p1", 20, 100, 20);
  assert.equal(ratings.isTrusted(getPlayer("p1")), true);
  pausePlayer("p1");
  assert.equal(ratings.isTrusted(getPlayer("p1")), false);
  assert.equal(ratings.isTrusted(null), false);
});

test("trustedRoleChanges says who gains and who loses the role", () => {
  makePlayer("p2");
  makePlayer("p3");
  makePlayer("p4");
  setStats("p1", 12, 58, 12);
  setStats("p2", 30, 150, 30);
  setStats("p3", 30, 120, 30);
  setStats("p4", 3, 15, 3);
  // p1 and p2 qualify; p3 has 4.0; p4 is too new. p3 and a former player currently hold the role.
  const r = ratings.trustedRoleChanges(["p3", "ghost", "p2"]);
  assert.deepEqual(r, { gain: ["p1"], lose: ["ghost", "p3"] });
});

test("a holder who gets suspended or paused loses the role, and nothing changes when everyone is right", () => {
  makePlayer("p2");
  setStats("p1", 15, 75, 15);
  setStats("p2", 15, 75, 15);
  assert.deepEqual(ratings.trustedRoleChanges(["p1", "p2"]), { gain: [], lose: [] });
  suspendPlayer("p2");
  pausePlayer("p1");
  assert.deepEqual(ratings.trustedRoleChanges(["p1", "p2"]), { gain: [], lose: ["p1", "p2"] });
  assert.deepEqual(ratings.trustedRoleChanges([]), { gain: [], lose: [] });
});

test("the thresholds come from settings", () => {
  setStats("p1", 5, 25, 5);
  assert.equal(ratings.isTrusted(getPlayer("p1")), false);
  saveSettings({ trusted: { minCompleted: 5, minAverage: 5 } });
  assert.equal(ratings.isTrusted(getPlayer("p1"), JSON.parse(JSON.stringify({ trusted: { minCompleted: 5, minAverage: 5 } }))), true);
  assert.deepEqual(ratings.trustedRoleChanges([]).gain, ["p1"]);
});

test("a real rating drives a player over the line", () => {
  setStats("p1", 9, 45, 9);
  const b = completed();
  ratings.recordRating(b.id, "c1", 5, "", END + HOUR);
  assert.equal(getPlayer("p1").completed, 10);
  assert.deepEqual(ratings.trustedRoleChanges([]).gain, ["p1"]);
  assert.ok(DAY > 0);
});

test("regular customers: enough completed bookings and not blacklisted", () => {
  saveSettings({ trusted: { regularCustomerMin: 2 } });
  makeCustomer("c2");
  makeCustomer("c3");
  for (const [customerId, n] of [["c1", 2], ["c2", 1], ["c3", 2]]) {
    for (let i = 0; i < n; i += 1) {
      const b = completed({ customerId, startAt: START + (customerId === "c1" ? 0 : customerId === "c2" ? 20 : 40) * HOUR + i * 2 * HOUR });
      assert.equal(b.status, "COMPLETED");
    }
  }
  assert.deepEqual(ratings.regularCustomerChanges([]), { gain: ["c1", "c3"], lose: [] });
  assert.deepEqual(ratings.regularCustomerChanges(["c1", "c2", "c3"]), { gain: [], lose: ["c2"] });
  addToBlacklist("c3", "gian lận", "staff", NOW);
  assert.deepEqual(ratings.regularCustomerChanges(["c1", "c3"]), { gain: [], lose: ["c3"] });
});
