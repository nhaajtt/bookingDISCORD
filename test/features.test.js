import { NOW, HOUR, MIN, DAY, vn, makePlayer, makeCustomer, book, confirmed, getDb, getSettings, saveSettings } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, modalOf, buttonIds, lastPayload } from "./discord-fakes.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { cancel, actorFor, getBooking, complete, start, noShow, SYSTEM, createBooking } from "../src/domain/bookings.js";
import { dueWaitlist, getEntry, joinWaitlist, leaveWaitlist, listForCustomer, slotHeldForOthers, slotIsFree } from "../src/domain/waitlist.js";
import { createSeries, dueSeries, getSeries, listSeries } from "../src/domain/series.js";
import { nextFreeSlot, freeNow, searchPlayers } from "../src/domain/search.js";
import { playerStats, topPlayers, topCustomers, monthRange, monthKey, previousMonthKey, recordMonthlyWinners, winnersOf, badgesFor } from "../src/domain/stats.js";
import { getPlayer, setMedia } from "../src/domain/players.js";
import { runWaitlist } from "../src/jobs/waitlist.js";
import { runSeries } from "../src/jobs/series.js";
import { runLeaderboard } from "../src/jobs/leaderboard.js";
import { getAvailability } from "../src/domain/availability.js";
import { setGameRates } from "../src/domain/quoting.js";

const CUST3 = "900000000000000008";
let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player, { rateVnd: 100_000, games: ["Liên Quân", "LoL"] });
  makeCustomer(IDS.cust);
  makeCustomer(IDS.cust2);
  makeCustomer(CUST3);
  for (const id of [IDS.player, IDS.cust, IDS.cust2, CUST3]) env.guild.addMember({ id });
  await refreshCard(env.guild, IDS.player);
});
afterEach(() => {
  globalThis.fetch = undefined;
  setClock(() => NOW);
});

const START = NOW + 9 * HOUR; // Monday 19:00
const form = { game: "liên quân", when: "05/10 19:00", duration: "1" };
const gateway = () => {
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ code: "00", data: { checkoutUrl: "https://pay.payos.vn/web/abc", paymentLinkId: "abc" } }) });
};
const lastDm = (id) => dms(env.client, id).at(-1);

// ---------------------------------------------------------------- the waiting list

test("a taken slot offers to wait; joining puts the customer in line, once, up to five at a time", async () => {
  gateway();
  confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  const refused = await env.submit(IDS.cust2, `bk:new:${IDS.player}`, form);
  assert.match(textOf(refused), /Player đã có lịch khác.*Muốn được báo khi có chỗ trống không/s);
  const [joinId] = buttonIds(lastPayload(refused));
  assert.equal(joinId, `wt:join:${IDS.player}:${START}:60:0`);
  const joined = await env.click(IDS.cust2, joinId);
  assert.match(textOf(joined), /Đã đăng ký chờ Player 9000.* lúc T2 05\/10 19:00, 1 giờ/);
  assert.equal(listForCustomer(IDS.cust2).length, 1);
  assert.match(textOf(await env.click(IDS.cust2, joinId)), /đã đăng ký chờ khung giờ này rồi/);
  assert.equal(listForCustomer(IDS.cust2).length, 1);
  const hang = await env.command(IDS.cust2, "hangcho");
  assert.match(textOf(hang), /Đang chờ chỗ[\s\S]*Player 9000.*T2 05\/10 19:00/);
  assert.match(textOf(await env.command(IDS.cust, "hangcho")), /không chờ chỗ nào/);
  for (let i = 1; i <= 4; i += 1) joinWaitlist({ customerId: IDS.cust2, playerId: IDS.player, game: "LoL", startAt: START + i * DAY, durationMin: 60 }, NOW);
  assert.throws(() => joinWaitlist({ customerId: IDS.cust2, playerId: IDS.player, game: "LoL", startAt: START + 9 * DAY, durationMin: 60 }, NOW), /đang chờ 5 chỗ/);
});

test("joining the list is refused for the wrong things: a stranger, yourself, a game they do not play, a moment too soon", () => {
  const ok = { customerId: IDS.cust, playerId: IDS.player, game: "LoL", startAt: START, durationMin: 60 };
  assert.throws(() => joinWaitlist({ ...ok, customerId: IDS.player }, NOW), /chính mình/);
  assert.throws(() => joinWaitlist({ ...ok, customerId: IDS.rando }, NOW), /18 tuổi/);
  assert.throws(() => joinWaitlist({ ...ok, game: "Dota" }, NOW), /không chơi game/);
  assert.throws(() => joinWaitlist({ ...ok, startAt: NOW + 10 * MIN }, NOW), /đặt trước ít nhất/);
  assert.throws(() => joinWaitlist({ ...ok, durationMin: 45 }, NOW), /Thời lượng/);
  const entry = joinWaitlist(ok, NOW);
  assert.equal(leaveWaitlist(entry.id, IDS.cust2, NOW), false, "only the owner of the entry can leave it");
  assert.equal(leaveWaitlist(entry.id, IDS.cust, NOW), true);
  assert.equal(listForCustomer(IDS.cust).length, 0);
});

test("when the slot frees up the first in line is told and the slot is held for them; the next one waits until the hold ends", async () => {
  gateway();
  const taken = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  const first = joinWaitlist({ customerId: IDS.cust2, playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60 }, NOW);
  const second = joinWaitlist({ customerId: CUST3, playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60 }, NOW + 1);
  assert.deepEqual(dueWaitlist(NOW + 5 * MIN).notify, [], "the slot is still taken");

  cancel(taken.id, actorFor(getBooking(taken.id), IDS.cust), NOW + 10 * MIN);
  const due = dueWaitlist(NOW + 11 * MIN);
  assert.deepEqual(due.notify.map((w) => w.id), [first.id], "only the oldest entry of an overlapping group");
  const result = await runWaitlist(env.client, NOW + 11 * MIN);
  assert.equal(result.told, 1);
  assert.match(lastDm(IDS.cust2), /Có chỗ rồi!.*Player 9000.*T2 05\/10 19:00, 1 giờ, Liên Quân\. Giá 100\.000 đ\. Chỗ được giữ cho bạn 30 phút/);
  assert.deepEqual(env.client.dmLog.at(-1).payload.components.map((r) => r.toJSON().components.map((c) => c.custom_id)), [[`wt:book:${first.id}`, `wt:leave:${first.id}`]]);
  assert.deepEqual(dms(env.client, CUST3).filter((t) => /Có chỗ rồi/.test(t)), []);

  setClock(() => NOW + 12 * MIN);
  assert.equal(slotHeldForOthers(IDS.player, CUST3, START, 60, NOW + 12 * MIN), true);
  assert.equal(slotHeldForOthers(IDS.player, IDS.cust2, START, 60, NOW + 12 * MIN), false);
  assert.match(textOf(await env.submit(CUST3, `bk:new:${IDS.player}`, form)), /đang được giữ cho người đã đăng ký chờ/);
  assert.equal(slotIsFree(IDS.player, START, 60, NOW + 12 * MIN), true, "free for the list, just not for strangers");

  // the person told presses Book now: the form opens with the slot filled in, and booking it finishes the entry
  const open = await env.click(IDS.cust2, `wt:book:${first.id}`);
  const fields = modalOf(open).toJSON().components.map((r) => r.components[0]);
  assert.deepEqual([fields[0].value, fields[1].value, fields[2].value], ["Liên Quân", "05/10 19:00", "1"]);
  const booked = await env.submit(IDS.cust2, `bk:new:${IDS.player}`, form);
  assert.ok(lastPayload(booked).components[0].toJSON().components[0].url);
  assert.equal(getEntry(first.id).doneAt !== null, true);
  assert.equal(listForCustomer(IDS.cust2).length, 0);
  assert.equal(slotHeldForOthers(IDS.player, CUST3, START, 60, NOW + 13 * MIN), false, "a finished entry holds nothing");
  assert.equal(getEntry(second.id).notifiedAt, null);
});

test("a person who does not book inside the hold loses it and the next person is told", async () => {
  const taken = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  const first = joinWaitlist({ customerId: IDS.cust2, playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60 }, NOW);
  const second = joinWaitlist({ customerId: CUST3, playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60 }, NOW + 1);
  cancel(taken.id, actorFor(getBooking(taken.id), IDS.cust), NOW + 10 * MIN);
  await runWaitlist(env.client, NOW + 11 * MIN);
  await runWaitlist(env.client, NOW + 20 * MIN);
  assert.equal(getEntry(second.id).notifiedAt, null, "still waiting while the first holds the slot");
  const late = await runWaitlist(env.client, NOW + 11 * MIN + 31 * MIN);
  assert.equal(late.expired, 1);
  assert.match(lastDm(IDS.cust2), /Thời gian giữ chỗ T2 05\/10 19:00 .* đã hết/);
  assert.equal(getEntry(first.id).doneAt !== null, true);
  await runWaitlist(env.client, NOW + 43 * MIN);
  assert.match(lastDm(CUST3), /Có chỗ rồi!/);
});

test("an entry whose person cannot be reached by DM is dropped so the next one gets the chance, and old entries expire", async () => {
  const taken = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  const a = joinWaitlist({ customerId: IDS.cust2, playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60 }, NOW);
  joinWaitlist({ customerId: CUST3, playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60 }, NOW + 1);
  cancel(taken.id, actorFor(getBooking(taken.id), IDS.cust), NOW + 10 * MIN);
  env.client.closedDms.add(IDS.cust2);
  await runWaitlist(env.client, NOW + 11 * MIN);
  assert.equal(getEntry(a.id).doneAt !== null, true);
  await runWaitlist(env.client, NOW + 12 * MIN);
  assert.match(lastDm(CUST3), /Có chỗ rồi!/);
  const stale = await runWaitlist(env.client, START - 30 * MIN);
  assert.equal(stale.expired >= 1, true, "the time is too close to book now");
});

// ---------------------------------------------------------------- weekly repeats

test("a repeat is made from the booking form, books only the first week and keeps the rest as reminders", async () => {
  gateway();
  const bad = await env.submit(IDS.cust, `bk:new:${IDS.player}`, { ...form, repeat: "1" });
  assert.match(textOf(bad), /từ 2 đến 8/);
  assert.match(textOf(await env.submit(IDS.cust, `bk:new:${IDS.player}`, { ...form, repeat: "50" })), /từ 2 đến 8/);
  assert.match(textOf(await env.submit(IDS.cust, `bk:new:${IDS.player}`, { ...form, repeat: "abc" })), /từ 2 đến 8/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0, "a bad number creates nothing");
  const ok = await env.submit(IDS.cust, `bk:new:${IDS.player}`, { ...form, repeat: "3" });
  assert.match(textOf(ok), /Đã đặt lặp 3 tuần.*không tự trừ tiền/s);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 1);
  const [s] = listSeries(IDS.cust);
  assert.deepEqual([s.remaining, s.nextAt, s.durationMin, s.game], [2, START + 7 * DAY, 60, "Liên Quân"]);
  assert.equal(getBooking(1).series_id, s.id);
});

test("three days before a week the customer is asked once; the button books that week and moves the repeat on", async () => {
  gateway();
  const first = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  const series = createSeries({ bookingId: first.id, weeks: 3 }, NOW);
  assert.equal(dueSeries(START + 3 * DAY).length, 0, "next week is more than three days away");
  const t = START + 7 * DAY - 3 * DAY;
  assert.equal(dueSeries(t).length, 1);
  assert.deepEqual(await runSeries(env.client, t), { offered: 1 });
  assert.match(lastDm(IDS.cust), /Lặp hằng tuần: tuần tới bạn có hẹn Player 9000.* lúc T2 12\/10 19:00, 1 giờ, Liên Quân\. Giá 100\.000 đ\. Bấm Đặt tuần này/);
  assert.deepEqual(await runSeries(env.client, t + HOUR), { offered: 0 }, "once per week");
  const ids = env.client.dmLog.at(-1).payload.components[0].toJSON().components.map((c) => c.custom_id);
  assert.deepEqual(ids, [`sr:book:${series.id}:${START + 7 * DAY}`, `sr:skip:${series.id}:${START + 7 * DAY}`, `sr:stop:${series.id}`]);

  setClock(() => t + 2 * HOUR);
  assert.match(textOf(await env.click(IDS.cust2, ids[0])), /không có quyền/);
  const booked = await env.dmClick(IDS.cust, ids[0]);
  assert.ok(lastPayload(booked).components[0].toJSON().components[0].url, "the payment link of that week");
  const next = getBooking(2);
  assert.deepEqual([next.start_at, next.series_id, next.status], [START + 7 * DAY, series.id, "AWAITING_PAYMENT"]);
  assert.deepEqual([getSeries(series.id).remaining, getSeries(series.id).nextAt], [1, START + 14 * DAY]);
  assert.match(textOf(await env.click(IDS.cust, ids[0])), /đã cũ/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 2, "the old button booked nothing");
});

test("skipping, stopping, a taken slot and an unanswered week all move the repeat on without charging anything", async () => {
  const first = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  const series = createSeries({ bookingId: first.id, weeks: 4 }, NOW);
  const week = (n) => START + n * 7 * DAY;
  await runSeries(env.client, week(1) - 3 * DAY);
  const skip = await env.dmClick(IDS.cust, `sr:skip:${series.id}:${week(1)}`);
  assert.match(textOf(skip), /Đã bỏ tuần này\. Còn 2 tuần/);

  // week 2: somebody else already has the slot, so the customer is offered the waiting list
  confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: week(2) });
  await runSeries(env.client, week(2) - 3 * DAY);
  assert.match(lastDm(IDS.cust), /đã có lịch khác lúc T2 19\/10 19:00.*Muốn được báo/s);
  assert.match(buttonIds({ components: env.client.dmLog.at(-1).payload.components })[0], /^wt:join:/);
  assert.equal(getSeries(series.id).remaining, 1);

  // week 3: nobody answers, so it is dropped when its time comes and the repeat ends
  await runSeries(env.client, week(3) - 3 * DAY);
  assert.equal(getSeries(series.id).active, true);
  await runSeries(env.client, week(3) + HOUR);
  assert.equal(getSeries(series.id).active, false);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?").get(IDS.cust).n, 1);

  const other = createSeries({ bookingId: book({ customerId: IDS.cust, playerId: IDS.player, startAt: START + 2 * HOUR }).id, weeks: 2 }, NOW);
  assert.match(textOf(await env.dmClick(IDS.cust, `sr:stop:${other.id}`)), /Đã dừng lặp hằng tuần/);
  assert.match(textOf(await env.dmClick(IDS.cust, `sr:stop:${other.id}`)), /đã dừng/);
  assert.equal(listSeries(IDS.cust).length, 0);
});

test("a repeat needs a real booking, a sensible number of weeks, and the feature switched on", () => {
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START });
  assert.throws(() => createSeries({ bookingId: b.id, weeks: 1 }, NOW), /từ 2 đến 8/);
  assert.throws(() => createSeries({ bookingId: 999, weeks: 3 }, NOW), /Không tìm thấy lịch/);
  createSeries({ bookingId: b.id, weeks: 3 }, NOW);
  assert.throws(() => createSeries({ bookingId: b.id, weeks: 3 }, NOW), /đã nằm trong một chuỗi/);
  saveSettings({ ...getSettings(), maxSeriesWeeks: 0 });
  assert.throws(() => createSeries({ bookingId: b.id, weeks: 3 }, NOW), /đang tắt/);
});

// ---------------------------------------------------------------- finding players

function twoMorePlayers() {
  makePlayer("900000000000000011", { rateVnd: 150_000, games: ["Liên Quân", "Trò chuyện"] });
  getDb().prepare("UPDATE players SET languages = 'Tiếng Việt, English', rating_sum = 48, rating_count = 10, completed = 10 WHERE user_id = ?").run("900000000000000011");
  makePlayer("900000000000000012", { rateVnd: 60_000, games: ["LoL"], availability: "T3 10:00-12:00" });
  getDb().prepare("UPDATE players SET rating_sum = 20, rating_count = 5 WHERE user_id = ?").run("900000000000000012");
  getDb().prepare("UPDATE players SET rating_sum = 45, rating_count = 10, completed = 3 WHERE user_id = ?").run(IDS.player);
}
const P2 = "900000000000000011";
const P3 = "900000000000000012";

test("the search filters by game, price, rating, language and who is free, and sorts as asked", () => {
  twoMorePlayers();
  const names = (options, at = NOW) => searchPlayers(options, at).map((p) => p.userId);
  assert.deepEqual(names({}), [P2, IDS.player, P3], "by rating: 4.8, 4.5, 4.0");
  assert.deepEqual(names({ game: "liên quân" }), [P2, IDS.player]);
  assert.deepEqual(names({ game: "LoL" }), [IDS.player, P3]);
  assert.deepEqual(names({ maxRateVnd: 100_000 }), [IDS.player, P3]);
  assert.deepEqual(names({ minRating: 4.5 }), [P2, IDS.player]);
  assert.deepEqual(names({ language: "english" }), [P2]);
  assert.deepEqual(names({ sort: "gia-tang" }), [P3, IDS.player, P2]);
  assert.deepEqual(names({ sort: "gia-giam" }), [P2, IDS.player, P3]);
  assert.deepEqual(names({ sort: "gio" }).length, 3);
  assert.deepEqual(names({ excludeUserId: P2 }), [IDS.player, P3]);
  assert.deepEqual(names({ limit: 1 }), [P2]);
  assert.deepEqual(names({ game: "Dota" }), []);
  getDb().prepare("UPDATE players SET status = 'PAUSED' WHERE user_id = ?").run(P3);
  assert.deepEqual(names({}), [P2, IDS.player], "paused players are not offered");
});

test("a per-game price is what the search shows for that game", () => {
  twoMorePlayers();
  setGameRates(IDS.player, { "Liên Quân": 120_000 });
  assert.equal(searchPlayers({ game: "Liên Quân" }, NOW).find((p) => p.userId === IDS.player).rateVnd, 120_000);
  assert.equal(searchPlayers({ game: "LoL" }, NOW).find((p) => p.userId === IDS.player).rateVnd, 100_000);
  assert.deepEqual(searchPlayers({ game: "Liên Quân", maxRateVnd: 110_000 }, NOW).map((p) => p.userId), [], "the filter uses the game's price");
});

test("free now means inside the weekly hours with nothing booked on top, and the next free slot respects lead time and bookings", () => {
  twoMorePlayers();
  assert.equal(freeNow(IDS.player, NOW), true);
  assert.equal(freeNow(P3, NOW), false, "P3 only works on Tuesday mornings");
  confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR });
  const at = NOW + 2 * HOUR + 5 * MIN;
  assert.equal(freeNow(IDS.player, at), false, "a running booking occupies the half hour");
  assert.equal(searchPlayers({ freeNow: true }, at).some((p) => p.userId === IDS.player), false);
  const next = nextFreeSlot(IDS.player, 60, at);
  assert.equal(next % (30 * MIN), 0);
  assert.ok(next >= at + 60 * MIN, "at least the minimum lead time");
  assert.equal(nextFreeSlot(IDS.player, 60, NOW), NOW + 60 * MIN, "an hour from now, before the booked session at 12:00 it still fits");
  assert.equal(nextFreeSlot(P3, 60, NOW), vn(2026, 10, 6, 10, 0), "Tuesday 10:00 is the first hour P3 works");
  assert.equal(nextFreeSlot(P3, 180, NOW), null, "a three hour session never fits a two hour window");
  getDb().prepare("DELETE FROM availability WHERE player_id = ?").run(P3);
  assert.equal(nextFreeSlot(P3, 60, NOW), null);
});

test("/timplayer answers with a list, buttons to book, and a clear message when nothing matches", async () => {
  twoMorePlayers();
  const i = await env.command(IDS.cust, "timplayer", { opts: { game: "Liên Quân", "sap-xep": "gia-tang" } });
  const text = textOf(i);
  assert.match(text, /Tìm thấy 2 player/);
  assert.match(text, /1\. \*\*Player 9000.*\*\* \| 4\.5★ \(10\) \| 100\.000 đ\/giờ \| Liên Quân, LoL \| đang rảnh/);
  assert.match(text, /2\. \*\*Player 9000.*\| 150\.000 đ\/giờ/);
  assert.deepEqual(buttonIds(lastPayload(i)), [`pl:book:${IDS.player}`, `pl:book:${P2}`]);
  assert.match(textOf(await env.command(IDS.cust, "timplayer", { opts: { game: "Dota" } })), /Không có player nào khớp/);
  assert.match(textOf(await env.command(IDS.rando, "timplayer", {})), /18 tuổi/);
  const options = await env.autocomplete(IDS.cust, "timplayer", { focused: "tr" });
  assert.deepEqual(options.out.find((o) => o.type === "autocomplete").choices.map((c) => c.value), ["Trò chuyện"]);
  const book = await env.click(IDS.cust, `pl:book:${P2}`);
  assert.ok(modalOf(book));
});

// ---------------------------------------------------------------- statistics, badges and leaderboards

function finish(playerId, customerId, startAt, minutes = 60) {
  const prior = startAt - 2 * DAY;
  const b = confirmed({ customerId, playerId, startAt, durationMin: minutes, now: prior });
  start(b.id, SYSTEM, startAt);
  complete(b.id, SYSTEM, startAt + minutes * MIN);
  return b;
}

test("player statistics count hours, reliability and repeat customers from the bookings", () => {
  for (let i = 0; i < 4; i += 1) finish(IDS.player, i < 3 ? IDS.cust : IDS.cust2, NOW + (i + 1) * DAY, i === 0 ? 90 : 60);
  const lost = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 6 * DAY });
  noShow(lost.id, "player", SYSTEM, NOW + 6 * DAY + 20 * MIN);
  const stats = playerStats(IDS.player);
  assert.deepEqual(stats, { completed: 4, hours: 4.5, repeatCustomers: 1, sessions: 5, reliability: 80 });
  assert.deepEqual(playerStats("nobody"), { completed: 0, hours: 0, repeatCustomers: 0, sessions: 0, reliability: null });
});

test("months are read on the server's wall clock and the winners of a finished month are written once", () => {
  assert.deepEqual(monthRange("2026-10", "Asia/Ho_Chi_Minh"), { from: vn(2026, 10, 1, 0, 0), to: vn(2026, 11, 1, 0, 0) });
  assert.deepEqual(monthRange("2026-12", "Asia/Ho_Chi_Minh"), { from: vn(2026, 12, 1, 0, 0), to: vn(2027, 1, 1, 0, 0) });
  assert.equal(monthKey(NOW, "Asia/Ho_Chi_Minh"), "2026-10");
  assert.equal(previousMonthKey(NOW, "Asia/Ho_Chi_Minh"), "2026-09");
  assert.equal(previousMonthKey(vn(2027, 1, 3, 9, 0), "Asia/Ho_Chi_Minh"), "2026-12");
  assert.equal(monthKey(vn(2026, 9, 30, 23, 30), "Asia/Ho_Chi_Minh"), "2026-09", "23:30 local is still September although it is October in UTC");

  makePlayer(P2, { rateVnd: 100_000 });
  finish(IDS.player, IDS.cust, vn(2026, 9, 20, 19, 0), 120);
  finish(P2, IDS.cust2, vn(2026, 9, 21, 19, 0), 60);
  const { from, to } = monthRange("2026-09", "Asia/Ho_Chi_Minh");
  assert.deepEqual(topPlayers({ from, to }).map((p) => [p.userId, p.hours]), [[IDS.player, 2], [P2, 1]]);
  assert.deepEqual(topCustomers({ from, to }).map((c) => [c.userId, c.spentVnd]), [[IDS.cust, 200_000], [IDS.cust2, 100_000]]);
  assert.equal(winnersOf("2026-09"), null);
  const first = recordMonthlyWinners("2026-09");
  finish(IDS.player, IDS.cust, vn(2026, 9, 25, 19, 0), 600 > 240 ? 240 : 60);
  assert.deepEqual(recordMonthlyWinners("2026-09"), first, "later corrections do not rewrite what was announced");
  assert.equal(winnersOf("2026-09").players[0].userId, IDS.player);
});

function makeP2Player() {
  makePlayer(P2, { rateVnd: 100_000 });
}

test("badges: top of last month, hours milestones, punctuality and loyal customers", () => {
  makeP2Player();
  const stats = { hours: 55, sessions: 12, reliability: 100, repeatCustomers: 4 };
  assert.deepEqual(badgesFor(getPlayer(IDS.player), stats, NOW), ["50 giờ", "Đúng giờ", "Nhiều khách quay lại"]);
  assert.deepEqual(badgesFor(getPlayer(IDS.player), { ...stats, hours: 120, reliability: 90 }, NOW), ["100 giờ", "Nhiều khách quay lại"]);
  finish(IDS.player, IDS.cust, vn(2026, 9, 20, 19, 0), 120);
  recordMonthlyWinners("2026-09");
  assert.equal(badgesFor(getPlayer(IDS.player), stats, NOW)[0], "Top tháng trước");
  assert.equal(badgesFor(getPlayer(P2), { hours: 0, sessions: 0, reliability: null, repeatCustomers: 0 }, NOW).length, 0);
  assert.equal(badgesFor(getPlayer(IDS.player), stats, vn(2026, 11, 3, 10, 0)).includes("Top tháng trước"), false, "only the month right after");
});

test("the profile card shows the badges, hours, reliability, per-game prices, links and the first photo", async () => {
  for (let i = 0; i < 5; i += 1) finish(IDS.player, IDS.cust, NOW + (i + 1) * DAY);
  setGameRates(IDS.player, { "Liên Quân": 130_000 });
  setMedia(IDS.player, { photos: ["https://img.example/a.png", "https://img.example/b.png"], voiceUrl: "https://example.com/hi.mp3" });
  await refreshCard(env.guild, IDS.player);
  const card = env.channel("playersChannelId").sent.find((m) => m.id === getPlayer(IDS.player).profileMessageId).embeds[0];
  const field = (name) => card.fields.find((f) => f.name === name)?.value;
  assert.match(field("Giá"), /100\.000 đ \/ giờ\nLiên Quân: 130\.000 đ/);
  assert.match(field("Đã hoàn thành"), /5 buổi, 5 giờ/);
  assert.equal(field("Tỉ lệ đúng hẹn"), "100%");
  assert.match(field("Giọng nói"), /\[Nghe thử\]\(https:\/\/example\.com\/hi\.mp3\)/);
  assert.match(field("Thêm ảnh"), /\[Ảnh 2\]\(https:\/\/img\.example\/b\.png\)/);
  assert.equal(card.image.url, "https://img.example/a.png");
});

test("/bangxephang shows this month so far or last month, and the monthly job posts once", async () => {
  finish(IDS.player, IDS.cust, vn(2026, 9, 20, 19, 0), 120);
  finish(IDS.player, IDS.cust2, NOW + DAY, 60);
  setClock(() => NOW + 3 * DAY);
  const now_ = textOf(await env.command(IDS.cust, "bangxephang"));
  assert.match(now_, /Bảng xếp hạng tháng 2026-10 \(đến hiện tại\)/);
  assert.match(now_, /1\. Player 9000.*: 1 giờ, 1 buổi/);
  const last = textOf(await env.command(IDS.cust, "bangxephang", { opts: { thang: "truoc" } }));
  assert.match(last, /Bảng xếp hạng tháng 2026-09/);
  assert.match(last, new RegExp(`1\\. <@${IDS.cust}>: 200\\.000 đ, 1 buổi`));
  assert.match(textOf(await env.command(IDS.rando, "bangxephang")), /18 tuổi/);

  const channel = env.channel("feedbackChannelId");
  const before = channel.sent.length;
  assert.deepEqual(await runLeaderboard(env.client, NOW), { posted: true });
  assert.equal(channel.sent.length, before + 1);
  assert.match(JSON.stringify(channel.sent.at(-1).embeds), /Bảng xếp hạng tháng 2026-09/);
  assert.deepEqual(await runLeaderboard(env.client, NOW + HOUR), { posted: false });
  assert.equal(channel.sent.length, before + 1, "never twice for the same month");
});

test("a month with no sessions posts nothing but is still marked done", async () => {
  const before = env.channel("feedbackChannelId").sent.length;
  assert.deepEqual(await runLeaderboard(env.client, NOW), { posted: false });
  assert.equal(env.channel("feedbackChannelId").sent.length, before);
  assert.deepEqual(await runLeaderboard(env.client, NOW + HOUR), { posted: false });
});

// ---------------------------------------------------------------- entering hours with menus

test("the hours picker builds a schedule from menus, merges ranges, and only ever changes the clicker's own schedule", async () => {
  getDb().prepare("DELETE FROM availability WHERE player_id = ?").run(IDS.player);
  const open = await env.command(IDS.player, "lichranh", { opts: { chon: true } });
  const view = lastPayload(open);
  assert.deepEqual(view.components.map((r) => r.toJSON().components[0].custom_id), ["av:day:0.-1.-1", "av:from:0.-1.-1", "av:to:0.-1.-1", "av:add:0.-1.-1"]);
  assert.match(view.content, /Lịch rảnh hiện tại: chưa có/);
  assert.equal(view.components[3].toJSON().components[0].disabled, true, "nothing to add yet");

  const days = await env.pick(IDS.player, "av:day:0.-1.-1", ["1", "2", "0"]);
  const afterDays = lastPayload(days);
  assert.equal(afterDays.components[1].toJSON().components[0].custom_id, "av:from:7.-1.-1", "Sunday, Monday and Tuesday make mask 7");
  const from = await env.pick(IDS.player, "av:from:7.-1.-1", ["19"]);
  assert.equal(lastPayload(from).components[2].toJSON().components[0].custom_id, "av:to:7.19.-1");
  const to = await env.pick(IDS.player, "av:to:7.19.-1", ["23"]);
  const ready = lastPayload(to);
  assert.equal(ready.components[3].toJSON().components[0].custom_id, "av:add:7.19.23");
  assert.equal(ready.components[3].toJSON().components[0].disabled, false);
  const added = await env.click(IDS.player, "av:add:7.19.23");
  assert.match(lastPayload(added).content, /Đã thêm khung giờ\.\nLịch rảnh hiện tại: T2 19:00-23:00; T3 19:00-23:00; CN 19:00-23:00/);
  assert.deepEqual(getAvailability(IDS.player).length, 3);

  await env.click(IDS.player, "av:add:4.9.12");
  assert.match(formatNow(), /T3 09:00-12:00, 19:00-23:00/);
  await env.click(IDS.player, "av:add:4.12.14");
  assert.match(formatNow(), /T3 09:00-14:00, 19:00-23:00/, "touching ranges are merged");

  const bad = await env.click(IDS.player, "av:add:0.-1.-1");
  assert.match(lastPayload(bad).content, /Chọn ngày và giờ bắt đầu/);
  const wrongOrder = await env.click(IDS.player, "av:add:4.20.10");
  assert.match(lastPayload(wrongOrder).content, /Chọn ngày và giờ bắt đầu/);
  assert.match(textOf(await env.click(IDS.cust, "av:add:4.9.12")), /Chỉ player đã được duyệt/);
  assert.equal(getAvailability(IDS.cust).length, 0);

  const cleared = await env.click(IDS.player, "av:clear");
  assert.match(lastPayload(cleared).content, /Đã xoá toàn bộ lịch rảnh/);
  assert.equal(getAvailability(IDS.player).length, 0);
  assert.match(textOf(await env.command(IDS.cust, "lichranh", { opts: { chon: true } })), /Chỉ player đã được duyệt/);
});

function formatNow() {
  return getAvailability(IDS.player).filter((s) => s.weekday === 2).map((s) => `T3 ${String(s.startMin / 60).padStart(2, "0")}:00-${String(s.endMin / 60).padStart(2, "0")}:00`).join(", ").replace(/T3 (\d+:00-\d+:00), T3 /, "T3 $1, ");
}

test("an hours picker with out-of-range numbers in the ids does nothing harmful", async () => {
  const day = await env.pick(IDS.player, "av:day:999.77.-5", ["9", "x"]);
  assert.equal(lastPayload(day).components[1].toJSON().components[0].custom_id, "av:from:0.-1.-1");
  const to = await env.pick(IDS.player, "av:to:0.-1.-1", ["99"]);
  assert.ok(lastPayload(to));
});

// ---------------------------------------------------------------- prices per game and profile media

test("/player gia-theo-game opens a form with the current prices, saves valid lines and explains invalid ones", async () => {
  const open = await env.command(IDS.player, "player", { subcommand: "gia-theo-game" });
  assert.equal(modalOf(open).toJSON().custom_id, "pl:rates:submit");
  const bad = await env.submit(IDS.player, "pl:rates:submit", { rates: "Dota 100000" });
  assert.match(textOf(bad), /không nằm trong danh sách game/);
  const ok = await env.submit(IDS.player, "pl:rates:submit", { rates: "Liên Quân 130k\nlol 90.000" });
  assert.match(textOf(ok), /Đã lưu giá riêng cho 2 game/);
  const again = await env.command(IDS.player, "player", { subcommand: "gia-theo-game" });
  assert.equal(modalOf(again).toJSON().components[0].components[0].value, "Liên Quân 130000\nLoL 90000");
  assert.match(textOf(await env.submit(IDS.player, "pl:rates:submit", { rates: "" })), /Đã xoá giá riêng/);
  assert.match(textOf(await env.submit(IDS.cust, "pl:rates:submit", { rates: "Liên Quân 130k" })), /Chỉ player đã được duyệt/);
  assert.match(textOf(await env.submit(IDS.player, "pl:rates:submit", { rates: "Liên Quân 2000000" })), /Giá theo giờ phải từ/);
});

test("/player anh-gioi-thieu saves https links only and the card follows", async () => {
  const open = await env.command(IDS.player, "player", { subcommand: "anh-gioi-thieu" });
  assert.deepEqual(modalOf(open).toJSON().components.map((r) => r.components[0].custom_id), ["photo1", "photo2", "photo3", "voice"]);
  assert.match(textOf(await env.submit(IDS.player, "pl:media:submit", { photo1: "http://x.example/a.png", photo2: "", photo3: "", voice: "" })), /https/);
  const ok = await env.submit(IDS.player, "pl:media:submit", { photo1: "https://i.example/a.png", photo2: "https://i.example/b.png", photo3: "", voice: "https://v.example/me.mp3" });
  assert.match(textOf(ok), /Đã lưu 2 ảnh và link giọng nói/);
  assert.deepEqual(getPlayer(IDS.player).photos, ["https://i.example/a.png", "https://i.example/b.png"]);
  const card = env.channel("playersChannelId").sent.find((m) => m.id === getPlayer(IDS.player).profileMessageId).embeds[0];
  assert.equal(card.image.url, "https://i.example/a.png");
  assert.match(textOf(await env.submit(IDS.cust, "pl:media:submit", { photo1: "https://i.example/a.png" })), /Chỉ player đã được duyệt/);
});

test("the booking and top-up forms and the DM buttons that exist are the ones the router accepts without a guild", async () => {
  const { DM_PREFIXES } = await import("../src/discord/router.js");
  for (const prefix of ["bk:rate", "bk:problem", "bk:cancel", "bk:new", "bk:wallet", "bk:paylink", "wt:book", "wt:leave", "sr:book", "sr:skip", "sr:stop"]) assert.ok(DM_PREFIXES.includes(prefix), prefix);
  for (const staffOnly of ["mn", "dp", "ad", "pl:approve", "rp:done", "av:add"]) assert.ok(!DM_PREFIXES.includes(staffOnly), staffOnly);
  const before = await env.dmClick(IDS.cust, "mn:paid:1");
  assert.equal(before.out.length, 0, "a staff button from a DM is ignored");
  assert.ok(getBooking);
  assert.ok(createBooking && cancel && actorFor);
});
