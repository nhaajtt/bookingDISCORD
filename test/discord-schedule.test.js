import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, confirmed, book, ledgerRows, sum, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { boot, IDS } from "./discord-env.js";
import { dms, buttonIds, P } from "./discord-fakes.js";
import { runSchedule } from "../src/jobs/schedule.js";
import { getBooking, endOf } from "../src/domain/bookings.js";
import { getPlayer } from "../src/domain/players.js";
import { activeStrikeCount } from "../src/domain/strikes.js";
import { roomOverwrites } from "../src/discord/rooms.js";
import { getSettings } from "../src/settings.js";
import { setClock } from "../src/discord/clock.js";

let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
});

const START = NOW + 26 * HOUR;
const tick = (t) => runSchedule(env.client, { now: t });
const sent = (userId) => dms(env.client, userId);
const withBooking = (options = {}) => confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START, ...options });
const rooms = (b) => {
  const fresh = getBooking(b.id);
  return { text: env.guild.channels.cache.get(fresh.text_channel_id), voice: env.guild.channels.cache.get(fresh.voice_channel_id) };
};
const join = (voice, ...ids) => ids.forEach((id) => voice.members.set(id, { id }));
const quiet = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
};

test("a whole booking over its day: reminders once each, rooms, start on voice presence, auto end, rating, rooms closed", async () => {
  const b = withBooking();

  // 24 hours before: one reminder, never two
  await tick(START - 24 * HOUR + MIN);
  assert.equal(sent(IDS.cust).filter((t) => /Nhắc lịch #1/.test(t) && /ngày mai/.test(t)).length, 1);
  assert.equal(sent(IDS.player).filter((t) => /Nhắc lịch #1/.test(t)).length, 1);
  await tick(START - 24 * HOUR + 2 * MIN);
  assert.equal(sent(IDS.cust).filter((t) => /Nhắc lịch/.test(t)).length, 1, "the same tick twice sends nothing new");

  await tick(START - HOUR + MIN);
  assert.equal(sent(IDS.cust).filter((t) => /còn khoảng 1 giờ/.test(t)).length, 1);
  assert.equal(getBooking(b.id).text_channel_id, null, "no rooms an hour before");

  // 10 minutes before: the reminder and the private rooms
  await tick(START - 10 * MIN + 1000);
  assert.equal(sent(IDS.cust).filter((t) => /còn 10 phút nữa/.test(t)).length, 1);
  const { text, voice } = rooms(b);
  assert.ok(text && voice);
  assert.equal(text.name, "lich-1-text");
  assert.equal(voice.name, "lich-1-voice");
  assert.equal(text.type, ChannelType.GuildText);
  assert.equal(voice.type, ChannelType.GuildVoice);
  assert.equal(text.parentId, getSettings().channels.roomsCategoryId);
  assert.equal(voice.userLimit, 2);
  assert.ok(getBooking(b.id).reminders_sent.openRooms);

  const settings = getSettings();
  const expected = roomOverwrites(env.guild, getBooking(b.id), env.client.user.id, settings);
  assert.deepEqual(text.overwrites, expected.text);
  assert.deepEqual(voice.overwrites, expected.voice);
  const byId = (list, id) => list.find((o) => o.id === id);
  assert.ok(byId(text.overwrites, env.guild.id).deny.includes(P.ViewChannel), "everyone is shut out");
  for (const id of [IDS.cust, IDS.player]) {
    assert.ok(byId(text.overwrites, id).allow.includes(P.SendMessages));
    assert.ok(byId(voice.overwrites, id).allow.includes(P.Connect));
    assert.ok(byId(text.overwrites, id).deny.includes(P.MentionEveryone));
  }
  assert.ok(byId(text.overwrites, settings.roles.staffRoleId).deny.includes(P.SendMessages), "staff read only");
  assert.ok(byId(voice.overwrites, settings.roles.staffRoleId).deny.includes(P.Connect), "staff cannot join voice yet");
  assert.equal(text.overwrites.filter((o) => ![env.guild.id, IDS.cust, IDS.player, settings.roles.staffRoleId, env.client.user.id].includes(o.id)).length, 0, "nobody else is in the room");

  const welcome = text.sent[0];
  assert.match(welcome.content, new RegExp(`<@${IDS.cust}> và <@${IDS.player}>`));
  assert.match(welcome.content, /T3 06\/10 12:00, kéo dài 1 giờ/);
  assert.deepEqual(welcome.allowedMentions, { parse: [], users: [IDS.cust, IDS.player] });
  assert.deepEqual(buttonIds({ components: welcome.components }), ["bk:extend:1", "bk:problem:1", "bk:cancel:1"]);

  // Nobody is in voice yet at the start: nothing happens
  await tick(START + MIN);
  assert.equal(getBooking(b.id).status, "CONFIRMED");
  // Both join: the session starts
  join(voice, IDS.cust, IDS.player);
  await tick(START + 2 * MIN);
  assert.equal(getBooking(b.id).status, "IN_PROGRESS");
  assert.match(text.sent.at(-1).content, /Buổi hẹn đã bắt đầu, kết thúc lúc T3 06\/10 13:00\./);

  // The scheduled end
  await tick(endOf(b) - MIN);
  assert.equal(getBooking(b.id).status, "IN_PROGRESS");
  await tick(endOf(b));
  assert.equal(getBooking(b.id).status, "COMPLETED");
  assert.match(text.sent.at(-1).content, /Buổi hẹn đã kết thúc, cảm ơn hai bạn\./);
  assert.equal(sum(ledgerRows(b.id)), b.price_vnd);

  // Rating prompt: in the room and by DM, once
  await tick(endOf(b) + 30_000);
  const prompts = text.sent.filter((m) => /thấy buổi hẹn/.test(m.content));
  assert.equal(prompts.length, 1);
  assert.deepEqual(buttonIds({ components: prompts[0].components }), ["bk:rate:1:1", "bk:rate:1:2", "bk:rate:1:3", "bk:rate:1:4", "bk:rate:1:5", "bk:problem:1"]);
  assert.equal(sent(IDS.cust).filter((t) => /thấy buổi hẹn/.test(t)).length, 1);
  await tick(endOf(b) + 60_000);
  assert.equal(text.sent.filter((m) => /thấy buổi hẹn/.test(m.content)).length, 1);
  assert.equal(sent(IDS.cust).filter((t) => /thấy buổi hẹn/.test(t)).length, 1);

  // 15 minutes after the end the rooms are deleted
  await tick(endOf(b) + 14 * MIN);
  assert.equal(text.deleted, false);
  await tick(endOf(b) + 15 * MIN);
  assert.equal(text.deleted, true);
  assert.equal(voice.deleted, true);
  assert.ok(getBooking(b.id).reminders_sent.closeRooms);

  // When the review window closes without a rating the buttons come off the DM
  await tick(endOf(b) + 24 * HOUR + MIN);
  const dmRating = env.client.dmLog.find((d) => /thấy buổi hẹn/.test(d.payload.content)).message;
  assert.deepEqual(dmRating.components, []);
  assert.ok(getBooking(b.id).reminders_sent.autoComplete);
});

test("a reminder is not sent for a moment that had passed before the booking was paid", async () => {
  const start = NOW + 2 * HOUR;
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: start });
  const { pay } = await import("../src/domain/bookings.js");
  pay(b.id, start - 30 * MIN, b.price_vnd);
  await tick(start - 29 * MIN);
  assert.equal(sent(IDS.cust).filter((t) => /ngày mai|1 giờ/.test(t)).length, 0);
  await tick(start - 10 * MIN + 1000);
  assert.equal(sent(IDS.cust).filter((t) => /còn 10 phút/.test(t)).length, 1);
});

test("no-show of the player: waits one more tick, then refunds in full, strikes, tells everyone, logs", async () => {
  const b = withBooking();
  await tick(START - 10 * MIN + 1000);
  const { text, voice } = rooms(b);
  join(voice, IDS.cust);

  const late = START + 15 * MIN;
  await tick(late);
  assert.equal(getBooking(b.id).status, "CONFIRMED", "the first sight only notes it");
  await tick(late + 30_000);
  assert.equal(getBooking(b.id).status, "NO_SHOW_PLAYER");
  assert.equal(ledgerRows(b.id).find((r) => r.kind === "REFUND").amount_vnd, b.price_vnd);
  assert.equal(ledgerRows(b.id).some((r) => r.kind === "PLAYER_PAYOUT"), false);
  assert.equal(activeStrikeCount(IDS.player, late + 30_000), 1);
  assert.match(text.sent.at(-1).content, /Player vắng mặt, khách được hoàn 100%/);
  assert.match(sent(IDS.cust).join("\n"), /Player vắng mặt ở lịch #1, bạn được hoàn 100%/);
  assert.match(sent(IDS.player).join("\n"), /bị 1 cảnh cáo/);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /player vắng mặt, hoàn 100\.000 đ/);
  await tick(late + 60_000);
  assert.equal(activeStrikeCount(IDS.player, late + 60_000), 1, "nothing is applied twice");
});

test("a person who joins in the minute after the grace is not penalised", async () => {
  const b = withBooking();
  await tick(START - 10 * MIN + 1000);
  const { voice } = rooms(b);
  join(voice, IDS.cust);
  const late = START + 15 * MIN;
  await tick(late);
  join(voice, IDS.player);
  await tick(late + 30_000);
  assert.notEqual(getBooking(b.id).status, "NO_SHOW_PLAYER");
  assert.equal(getBooking(b.id).status, "IN_PROGRESS");
  assert.equal(activeStrikeCount(IDS.player, late + 30_000), 0);
});

test("no-show of the customer pays the player; both absent cancels with a full refund and no strikes", async () => {
  const b = withBooking();
  await tick(START - 10 * MIN + 1000);
  join(rooms(b).voice, IDS.player);
  const late = START + 16 * MIN;
  await tick(late);
  await tick(late + 30_000);
  assert.equal(getBooking(b.id).status, "NO_SHOW_CUSTOMER");
  assert.ok(ledgerRows(b.id).some((r) => r.kind === "PLAYER_PAYOUT"));
  assert.match(sent(IDS.player).join("\n"), /Khách vắng mặt ở lịch #1, bạn vẫn được thanh toán/);
  assert.match(sent(IDS.cust).join("\n"), /bị 1 cảnh cáo/);

  const other = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: START + 5 * HOUR });
  await tick(START + 5 * HOUR - 10 * MIN + 1000);
  const t2 = START + 5 * HOUR + 16 * MIN;
  await tick(t2);
  await tick(t2 + 30_000);
  assert.equal(getBooking(other.id).status, "CANCELLED");
  assert.equal(getBooking(other.id).cancelled_by, "system");
  assert.equal(ledgerRows(other.id).find((r) => r.kind === "REFUND").amount_vnd, other.price_vnd);
  assert.equal(activeStrikeCount(IDS.player, t2), 0);
  assert.equal(activeStrikeCount(IDS.cust, t2), 1, "only the earlier customer no-show counts");
});

test("an unpaid booking expires after the payment window and the customer is told", async () => {
  const b = book({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 5 * HOUR });
  await tick(NOW + 29 * MIN);
  assert.equal(getBooking(b.id).status, "AWAITING_PAYMENT");
  await tick(NOW + 31 * MIN);
  assert.equal(getBooking(b.id).status, "EXPIRED");
  assert.match(sent(IDS.cust).join("\n"), /Lịch #1 đã hết hạn thanh toán/);
  await tick(NOW + 32 * MIN);
  assert.equal(sent(IDS.cust).filter((t) => /hết hạn/.test(t)).length, 1);
});

test("if the voice room cannot be created the text room is removed again and the next tick retries", async () => {
  const b = withBooking();
  const create = env.guild.channels.create;
  let failures = 1;
  env.guild.channels.create = async (options) => {
    if (options.type === ChannelType.GuildVoice && failures-- > 0) throw new Error("Maximum number of channels reached");
    return create(options);
  };
  const t = START - 10 * MIN + 1000;
  const first = await quiet(() => tick(t));
  assert.equal(first.failed, 1);
  assert.equal(getBooking(b.id).text_channel_id, null);
  assert.equal(env.guild.channelNamed("lich-1-text"), undefined, "no stray text room");
  const second = await tick(t + 30_000);
  assert.equal(second.failed, 0);
  assert.ok(rooms(b).voice);
  assert.equal(env.guild.channels.cache.filter((c) => c.name === "lich-1-text").size, 1);
});

test("closing rooms: a room that is already gone counts as done, a real failure is retried", async () => {
  const b = withBooking();
  await tick(START - 10 * MIN + 1000);
  join(rooms(b).voice, IDS.cust, IDS.player);
  await tick(START + MIN);
  await tick(endOf(b));
  const { text, voice } = rooms(b);
  text.failDelete = true;
  const close = endOf(b) + 15 * MIN;
  const failed = await quiet(() => tick(close));
  assert.ok(failed.failed >= 1);
  assert.equal(getBooking(b.id).reminders_sent.closeRooms, undefined, "not marked while it failed");
  text.failDelete = false;
  voice.deleted = true;
  env.guild.channels.cache.delete(voice.id);
  await tick(close + 30_000);
  assert.equal(text.deleted, true);
  assert.ok(getBooking(b.id).reminders_sent.closeRooms);
});

test("a cancelled booking's rooms are closed 15 minutes after the cancellation", async () => {
  const b = withBooking();
  await tick(START - 10 * MIN + 1000);
  const { text } = rooms(b);
  const { cancel, staffActor } = await import("../src/domain/bookings.js");
  cancel(b.id, staffActor("s"), START - 5 * MIN);
  await tick(START + 9 * MIN);
  assert.equal(text.deleted, false);
  await tick(START + 11 * MIN);
  assert.equal(text.deleted, true);
});

test("a closed DM does not stop the rating prompt being marked done", async () => {
  const b = withBooking();
  await tick(START - 10 * MIN + 1000);
  join(rooms(b).voice, IDS.cust, IDS.player);
  await tick(START + MIN);
  env.client.closedDms.add(IDS.cust);
  await tick(endOf(b));
  await tick(endOf(b) + 30_000);
  assert.ok(getBooking(b.id).reminders_sent.askRating);
  assert.equal(rooms(b).text.sent.filter((m) => /thấy buổi hẹn/.test(m.content)).length, 1);
});

test("a tick with no guild or nothing due does nothing and never throws", async () => {
  assert.deepEqual(await runSchedule({}, { now: NOW }), { ran: 0, failed: 0 });
  assert.deepEqual(await tick(NOW), { ran: 0, failed: 0 });
  assert.ok(DAY && setClock && getPlayer && getDb);
});
