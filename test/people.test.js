import { fresh, makePlayer, makeCustomer, NOW, DAY, HOUR, getDb, ALL_WEEK } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getAvailability } from "../src/domain/availability.js";
import { attest, hasAttested, getAttestation, isAttestPhrase, ATTEST_PHRASE } from "../src/domain/attestations.js";
import * as players from "../src/domain/players.js";
import * as strikes from "../src/domain/strikes.js";
import { saveSettings } from "../src/settings.js";

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code ?? `plain:${e.message}`;
  }
  return "no error";
};

const applicant = (extra = {}) => ({ userId: "u1", displayName: "Minh", games: ["Liên Quân"], rateVnd: 80_000, bio: "Rank cao", languages: "vi, en", ...extra });

beforeEach(fresh);

// ---------------------------------------------------------------- attestations

test("the 18+ attestation is stored once with its time and the first one wins", () => {
  assert.equal(hasAttested("u1"), false);
  assert.equal(getAttestation("u1"), null);
  const first = attest("u1", NOW);
  const again = attest("u1", NOW + DAY);
  assert.deepEqual(first, { userId: "u1", kind: "ADULT_18", at: NOW });
  assert.equal(again.at, NOW, "asking again does not move the timestamp");
  assert.equal(hasAttested("u1"), true);
  assert.equal(hasAttested("u2"), false);
});

test("the confirmation phrase ignores case, accents and spacing but nothing else", () => {
  for (const ok of [ATTEST_PHRASE, "tôi đã đủ 18 tuổi", "TOI DA DU 18 TUOI", "  Tôi   đã đủ 18   tuổi ", "toi da du 18 tuoi"]) assert.equal(isAttestPhrase(ok), true, ok);
  for (const bad of ["", "tôi đủ 18 tuổi", "tôi đã đủ 17 tuổi", "TÔI ĐÃ ĐỦ 18", null, undefined, "ok", "toi da du 18 tuoi!"]) assert.equal(isAttestPhrase(bad), false, String(bad));
});

// ---------------------------------------------------------------- applying

test("applying needs the attestation", () => {
  assert.equal(code(() => players.applyAsPlayer(applicant(), NOW)), "NOT_ATTESTED");
  attest("u1", NOW);
  const p = players.applyAsPlayer(applicant(), NOW);
  assert.equal(p.status, "PENDING");
  assert.equal(p.createdAt, NOW);
  assert.equal(p.approvedAt, null);
  assert.deepEqual(p.games, ["Liên Quân"]);
  assert.equal(p.average, 0);
});

test("blacklisted people cannot apply", () => {
  attest("u1", NOW);
  strikes.addToBlacklist("u1", "spam", "staff", NOW);
  assert.equal(code(() => players.applyAsPlayer(applicant(), NOW)), "BLACKLISTED");
});

test("the application is validated: name, games, rate", () => {
  attest("u1", NOW);
  assert.equal(code(() => players.applyAsPlayer(applicant({ displayName: "   " }), NOW)), "INVALID_INPUT");
  assert.equal(code(() => players.applyAsPlayer(applicant({ games: [] }), NOW)), "INVALID_INPUT");
  assert.equal(code(() => players.applyAsPlayer(applicant({ games: "" }), NOW)), "INVALID_INPUT");
  assert.equal(code(() => players.applyAsPlayer(applicant({ games: Array.from({ length: 9 }, (_, i) => `g${i}`) }), NOW)), "INVALID_INPUT");
  assert.equal(code(() => players.applyAsPlayer(applicant({ rateVnd: 10_000 }), NOW)), "BAD_RATE");
  assert.equal(code(() => players.applyAsPlayer(applicant({ rateVnd: 600_000 }), NOW)), "BAD_RATE");
  assert.equal(code(() => players.applyAsPlayer(applicant({ rateVnd: 55_500 }), NOW)), "BAD_RATE");
  assert.equal(players.getPlayer("u1"), null, "nothing was stored");
});

test("games may be a comma separated string, duplicates collapse, text is cleaned", () => {
  attest("u1", NOW);
  const p = players.applyAsPlayer(applicant({ games: "LoL, lol, Liên Quân;Trò chuyện", displayName: "<@123> Minh @everyone", bio: "xem https://x.test <@&5> nhé" }), NOW);
  assert.deepEqual(p.games, ["LoL", "Liên Quân", "Trò chuyện"]);
  assert.equal(p.displayName, "Minh");
  assert.equal(p.bio, "xem nhé");
});

test("applying again: a pending application is updated, a rejected one is reopened, a working player is refused", () => {
  attest("u1", NOW);
  players.applyAsPlayer(applicant(), NOW);
  const updated = players.applyAsPlayer(applicant({ rateVnd: 90_000 }), NOW + HOUR);
  assert.equal(updated.rateVnd, 90_000);
  assert.equal(updated.status, "PENDING");
  players.rejectPlayer("u1", "staff", "chưa đủ", NOW);
  assert.equal(players.getPlayer("u1").status, "REJECTED");
  assert.equal(players.applyAsPlayer(applicant(), NOW + DAY).status, "PENDING");
  players.approvePlayer("u1", "staff", NOW);
  assert.equal(code(() => players.applyAsPlayer(applicant(), NOW)), "ALREADY_PLAYER");
  players.pausePlayer("u1");
  assert.equal(code(() => players.applyAsPlayer(applicant(), NOW)), "ALREADY_PLAYER");
  players.suspendPlayer("u1");
  assert.equal(code(() => players.applyAsPlayer(applicant(), NOW)), "PLAYER_SUSPENDED");
});

test("rate limits follow the owner's settings", () => {
  attest("u1", NOW);
  saveSettings({ minRateVnd: 50_000, maxRateVnd: 60_000 });
  assert.equal(code(() => players.applyAsPlayer(applicant({ rateVnd: 80_000 }), NOW)), "BAD_RATE");
  assert.equal(players.applyAsPlayer(applicant({ rateVnd: 60_000 }), NOW).rateVnd, 60_000);
});

// ---------------------------------------------------------------- lifecycle

test("approve, reject, pause and resume follow the allowed moves only", () => {
  attest("u1", NOW);
  players.applyAsPlayer(applicant(), NOW);
  assert.equal(code(() => players.pausePlayer("u1")), "ILLEGAL_TRANSITION", "a pending player cannot pause");
  const approved = players.approvePlayer("u1", "staff", NOW + HOUR);
  assert.equal(approved.status, "ACTIVE");
  assert.equal(approved.approvedAt, NOW + HOUR);
  assert.equal(code(() => players.approvePlayer("u1", "staff", NOW)), "ILLEGAL_TRANSITION");
  assert.equal(code(() => players.rejectPlayer("u1", "staff", "", NOW)), "ILLEGAL_TRANSITION");
  assert.equal(players.pausePlayer("u1").status, "PAUSED");
  assert.equal(code(() => players.pausePlayer("u1")), "ILLEGAL_TRANSITION");
  assert.equal(players.resumePlayer("u1").status, "ACTIVE");
  assert.equal(code(() => players.resumePlayer("u1")), "ILLEGAL_TRANSITION");
  assert.equal(code(() => players.approvePlayer("ghost", "staff", NOW)), "NOT_FOUND");
});

test("a suspended player cannot resume by themselves", () => {
  makePlayer("p1");
  players.suspendPlayer("p1");
  assert.equal(code(() => players.resumePlayer("p1")), "ILLEGAL_TRANSITION");
  assert.equal(code(() => players.approvePlayer("p1", "staff", NOW)), "ILLEGAL_TRANSITION");
});

test("profile updates are validated and partial", () => {
  makePlayer("p1");
  const p = players.updateProfile("p1", { bio: "mới <@1>", rateVnd: 120_000 });
  assert.equal(p.bio, "mới");
  assert.equal(p.rateVnd, 120_000);
  assert.equal(p.displayName, "Player p1", "untouched fields stay");
  assert.equal(code(() => players.updateProfile("p1", { rateVnd: 5 })), "BAD_RATE");
  assert.equal(code(() => players.updateProfile("p1", { games: [] })), "INVALID_INPUT");
  assert.equal(code(() => players.updateProfile("ghost", {})), "NOT_FOUND");
});

test("availability text is stored only when it is fully valid", () => {
  makePlayer("p1");
  const bad = players.setAvailabilityText("p1", "T2 19:00-23:00; xyz");
  assert.equal(bad.ok, false);
  const before = players.setAvailabilityText("p1", "T2 19:00-23:00");
  assert.equal(before.ok, true);
  players.setAvailabilityText("p1", "T9 oops");
  assert.deepEqual(getAvailability("p1"), [{ weekday: 1, startMin: 1140, endMin: 1380 }], "the failed update changed nothing");
  assert.equal(code(() => players.setAvailabilityText("ghost", "T2 19:00-23:00")), "NOT_FOUND");
});

test("listPlayers filters by status and game", () => {
  makePlayer("a", { games: ["LoL"] });
  makePlayer("b", { games: ["Liên Quân", "LoL"], status: "PENDING" });
  makePlayer("c", { games: ["Valorant"], status: "PAUSED" });
  assert.deepEqual(players.listPlayers({ status: "PENDING" }).map((p) => p.userId), ["b"]);
  assert.deepEqual(players.listPlayers({ game: "lol" }).map((p) => p.userId).sort(), ["a", "b"]);
  assert.deepEqual(players.listPlayers({ status: "ACTIVE", game: "LoL" }).map((p) => p.userId), ["a"]);
  assert.equal(players.listPlayers().length, 3);
});

test("the profile message id is remembered", () => {
  makePlayer("p1");
  players.setProfileMessage("p1", "999");
  assert.equal(players.getPlayer("p1").profileMessageId, "999");
});

// ---------------------------------------------------------------- strikes

test("two strikes do nothing, the third inside 30 days suspends an active player", () => {
  makePlayer("p1");
  const a = strikes.addStrike("p1", 1, "player_cancel", NOW);
  const b = strikes.addStrike("p1", 2, "no_show_player", NOW + DAY);
  assert.deepEqual([a.count, a.suspended, b.count, b.suspended], [1, false, 2, false]);
  assert.equal(players.getPlayer("p1").status, "ACTIVE");
  const c = strikes.addStrike("p1", 3, "player_cancel", NOW + 2 * DAY);
  assert.deepEqual([c.count, c.suspended], [3, true]);
  assert.equal(players.getPlayer("p1").status, "SUSPENDED");
});

test("strikes older than 30 days no longer count", () => {
  makePlayer("p1");
  strikes.addStrike("p1", 1, "x", NOW);
  strikes.addStrike("p1", 2, "x", NOW + DAY);
  const third = strikes.addStrike("p1", 3, "x", NOW + 30 * DAY);
  assert.equal(third.count, 2, "the first strike aged out exactly at 30 days, the second is still inside");
  assert.equal(third.suspended, false);
  assert.equal(strikes.activeStrikeCount("p1", NOW + 30 * DAY - 1), 3, "one millisecond earlier the first strike still counted");
  assert.equal(strikes.activeStrikeCount("p1", NOW + 29 * DAY), 3);
  assert.equal(strikes.activeStrikeCount("p1", NOW + 60 * DAY), 0);
});

test("the same strike (user, booking, reason) is recorded once", () => {
  makePlayer("p1");
  const a = strikes.addStrike("p1", 7, "player_cancel", NOW);
  const b = strikes.addStrike("p1", 7, "player_cancel", NOW + HOUR);
  assert.equal(a.added, true);
  assert.equal(b.added, false);
  assert.equal(b.count, 1);
  strikes.addStrike("p1", 7, "no_show_player", NOW);
  assert.equal(strikes.listStrikes("p1").length, 2, "another reason for the same booking is a different strike");
});

test("manual strikes without a booking are allowed repeatedly", () => {
  makePlayer("p1");
  strikes.addStrike("p1", null, "hành vi xấu", NOW);
  strikes.addStrike("p1", null, "hành vi xấu", NOW);
  assert.equal(strikes.activeStrikeCount("p1", NOW), 2);
});

test("suspension applies to active and paused players, not to pending ones or customers", () => {
  makePlayer("paused", { status: "PAUSED" });
  makePlayer("pend", { status: "PENDING" });
  makeCustomer("cust");
  for (const who of ["paused", "pend", "cust"]) for (let i = 1; i <= 3; i += 1) strikes.addStrike(who, i, "x", NOW);
  assert.equal(players.getPlayer("paused").status, "SUSPENDED");
  assert.equal(players.getPlayer("pend").status, "PENDING");
  assert.equal(strikes.activeStrikeCount("cust", NOW), 3);
});

test("the limit and the window come from settings", () => {
  saveSettings({ strikeLimit: 2, strikeWindowDays: 10 });
  makePlayer("p1");
  strikes.addStrike("p1", 1, "x", NOW);
  assert.equal(strikes.addStrike("p1", 2, "x", NOW + 5 * DAY).suspended, true);
  makePlayer("p2");
  strikes.addStrike("p2", 1, "x", NOW);
  assert.equal(strikes.addStrike("p2", 2, "x", NOW + 11 * DAY).suspended, false);
});

test("lifting a suspension reactivates the player and clears the strikes that caused it", () => {
  makePlayer("p1");
  for (let i = 1; i <= 3; i += 1) strikes.addStrike("p1", i, "x", NOW);
  const r = strikes.liftSuspension("p1", "staff1", NOW + DAY);
  assert.equal(r.liftedBy, "staff1");
  assert.equal(players.getPlayer("p1").status, "ACTIVE");
  assert.equal(strikes.activeStrikeCount("p1", NOW + DAY), 0);
  assert.equal(strikes.listStrikes("p1").length, 3, "the history stays");
  assert.equal(strikes.addStrike("p1", 4, "x", NOW + 2 * DAY).suspended, false, "starts again from zero");
});

test("lifting a suspension that does not exist is refused", () => {
  makePlayer("p1");
  assert.equal(code(() => strikes.liftSuspension("p1", "staff", NOW)), "NOT_FOUND");
  assert.equal(code(() => strikes.liftSuspension("ghost", "staff", NOW)), "NOT_FOUND");
});

test("staff suspension can be lifted the same way", () => {
  makePlayer("p1");
  players.suspendPlayer("p1");
  strikes.liftSuspension("p1", "staff", NOW);
  assert.equal(players.getPlayer("p1").status, "ACTIVE");
});

// ---------------------------------------------------------------- blacklist

test("a blacklist entry needs a reason and is looked up by user", () => {
  assert.equal(code(() => strikes.addToBlacklist("u1", "  ", "staff", NOW)), "INVALID_INPUT");
  assert.equal(strikes.isBlacklisted("u1"), false);
  const e = strikes.addToBlacklist("u1", "lừa đảo   nhiều lần", "staff1", NOW);
  assert.deepEqual(e, { userId: "u1", reason: "lừa đảo nhiều lần", byUserId: "staff1", createdAt: NOW });
  assert.equal(strikes.isBlacklisted("u1"), true);
  assert.equal(strikes.listBlacklist().length, 1);
});

test("blacklisting again updates the reason and keeps one entry; removing works once", () => {
  strikes.addToBlacklist("u1", "một", "s1", NOW);
  strikes.addToBlacklist("u1", "hai", "s2", NOW + HOUR);
  assert.equal(strikes.listBlacklist().length, 1);
  assert.equal(strikes.getBlacklistEntry("u1").reason, "hai");
  assert.equal(strikes.getBlacklistEntry("u1").createdAt, NOW);
  assert.equal(strikes.removeFromBlacklist("u1"), true);
  assert.equal(strikes.removeFromBlacklist("u1"), false);
  assert.equal(strikes.isBlacklisted("u1"), false);
});

test("the all-week availability helper covers every day", () => {
  assert.equal(ALL_WEEK.split(";").length, 7);
});
