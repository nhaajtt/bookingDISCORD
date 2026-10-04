import { NOW, HOUR, MIN, makePlayer, makeCustomer, getDb } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms } from "./discord-fakes.js";
import { config } from "../src/config.js";
import { createWebServer } from "../src/web/server.js";
import { SESSION_COOKIE, SESSION_TTL_MS, signToken } from "../src/web/session.js";
import { runSchedule } from "../src/jobs/schedule.js";
import { getBooking, start, complete, SYSTEM } from "../src/domain/bookings.js";
import { adjustWallet } from "../src/domain/wallet.js";

// A booking made on the site must reach the same people the same way as one made in Discord: the player is told, the private
// rooms are opened by the schedule job, a cancellation reaches the player and the room, a rating reaches the feedback channel.

const SITE = "https://book.example.test";
const SECRET = "s".repeat(48);
const START = NOW + 26 * HOUR;

let env;
let web;
let base;

beforeEach(async () => {
  env = await boot();
  Object.assign(config.web, { discordClientSecret: "x", sessionSecret: SECRET, siteUrl: SITE });
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  env.world.client.guilds.cache.set(config.guildId, env.guild);
  web = createWebServer({ client: env.client, now: () => NOW });
  base = `http://127.0.0.1:${await web.listen(0, "127.0.0.1")}`;
});
afterEach(async () => {
  await web.close();
  Object.assign(config.web, { discordClientSecret: null, sessionSecret: null, siteUrl: null });
});

const call = (method, path, body, as = IDS.cust) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: SITE, cookie: `${SESSION_COOKIE}=${signToken(SECRET, "s", { uid: as, name: "Khách" }, SESSION_TTL_MS, NOW)}` },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("a wallet booking from the site tells the player, opens the rooms on time and ends like any other", async () => {
  adjustWallet(IDS.cust, 500_000, "thử", NOW);
  const made = await call("POST", "/api/bookings", { playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60, payWith: "wallet" });
  assert.equal(made.status, 201);
  const id = made.body.booking.id;
  assert.equal(getBooking(id).status, "CONFIRMED");
  assert.ok(dms(env.client, IDS.cust).some((t) => /Đã thanh toán bằng ví/.test(t)));
  assert.ok(dms(env.client, IDS.player).some((t) => /Bạn có lịch mới/.test(t)));

  await runSchedule(env.client, { now: START - 10 * MIN + 1000 });
  const row = getBooking(id);
  assert.ok(row.text_channel_id && row.voice_channel_id, "the private rooms are opened by the schedule job");
  const room = env.guild.channels.cache.get(row.text_channel_id);
  assert.ok(room);

  const seen = (await call("GET", "/api/me")).body.bookings[0];
  assert.equal(seen.roomUrl, `https://discord.com/channels/${config.guildId}/${row.text_channel_id}`);

  start(id, SYSTEM, START);
  complete(id, SYSTEM, START + HOUR);
  const rated = await call("POST", `/api/bookings/${id}/rate`, { stars: 5, review: "Vui lắm" });
  assert.equal(rated.status, 200);
  const feedback = env.channel("feedbackChannelId");
  assert.ok(feedback.sent.some((m) => JSON.stringify(m.embeds ?? []).includes("Vui lắm")), "the review reaches the feedback channel as from Discord");
});

test("cancelling from the site tells the player in Discord and refunds as the policy says", async () => {
  adjustWallet(IDS.cust, 500_000, "thử", NOW);
  const made = await call("POST", "/api/bookings", { playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60, payWith: "wallet" });
  const id = made.body.booking.id;
  const cancelled = await call("POST", `/api/bookings/${id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.refundVnd, 100_000);
  assert.ok(dms(env.client, IDS.player).some((t) => new RegExp(`Lịch #${id} đã bị huỷ`).test(t)));
  assert.equal(getDb().prepare("SELECT status FROM bookings WHERE id = ?").get(id).status, "CANCELLED");
});

test("someone who is not in the Discord server is turned away before anything is booked", async () => {
  const stranger = "900000000000000099";
  makeCustomer(stranger);
  const r = await call("POST", "/api/bookings", { playerId: IDS.player, game: "Liên Quân", startAt: START, durationMin: 60 }, stranger);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "NOT_IN_SERVER");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get().n, 0);
});
