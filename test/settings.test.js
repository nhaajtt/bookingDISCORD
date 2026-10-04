import { fresh } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, defaultSettings, getSettings, saveSettings, patchSettings, CHANNEL_KEYS, ROLE_KEYS } from "../src/settings.js";
import { readConfig } from "../src/config.js";

beforeEach(fresh);

test("defaults match the product decisions", () => {
  const s = defaultSettings();
  assert.equal(s.feePercent, 10);
  assert.equal(s.minLeadMin, 60);
  assert.equal(s.noShowGraceMin, 15);
  assert.equal(s.unpaidExpireMin, 30);
  assert.equal(s.reviewWindowHours, 24);
  assert.equal(s.maxActiveBookings, 3);
  assert.equal(s.maxDurationHours, 4);
  assert.equal(s.strikeLimit, 3);
  assert.equal(s.strikeWindowDays, 30);
  assert.equal(s.timezone, "Asia/Ho_Chi_Minh");
  assert.deepEqual(s.trusted, { minCompleted: 10, minAverage: 4.5, regularCustomerMin: 5 });
  assert.deepEqual(s.cancellation, [
    { minHoursBefore: 24, refundPercent: 100 },
    { minHoursBefore: 2, refundPercent: 50 },
    { minHoursBefore: 0, refundPercent: 0 },
  ]);
  for (const key of CHANNEL_KEYS) assert.equal(s.channels[key], null);
  for (const key of ROLE_KEYS) assert.equal(s.roles[key], null);
});

test("garbage in, a complete clean document out", () => {
  for (const junk of [null, undefined, 5, "text", [], { feePercent: "lots" }]) {
    const s = normalizeSettings(junk);
    assert.equal(s.feePercent, 10);
    assert.equal(s.cancellation.length, 3);
    assert.equal(typeof s.timezone, "string");
  }
});

test("every number is clamped to its range", () => {
  const s = normalizeSettings({
    feePercent: 99, maxDurationHours: 100, minLeadMin: -5, noShowGraceMin: 1, reviewWindowHours: 9999,
    maxActiveBookings: 0, strikeLimit: 500, strikeWindowDays: 0, unpaidExpireMin: 1, maxAdvanceDays: 1000,
    trusted: { minCompleted: 0, minAverage: 9, regularCustomerMin: 5000 },
  });
  assert.equal(s.feePercent, 50);
  assert.equal(s.maxDurationHours, 12);
  assert.equal(s.minLeadMin, 0);
  assert.equal(s.noShowGraceMin, 5);
  assert.equal(s.reviewWindowHours, 168);
  assert.equal(s.maxActiveBookings, 1);
  assert.equal(s.strikeLimit, 20);
  assert.equal(s.strikeWindowDays, 1);
  assert.equal(s.unpaidExpireMin, 10);
  assert.equal(s.maxAdvanceDays, 180);
  assert.deepEqual(s.trusted, { minCompleted: 1, minAverage: 5, regularCustomerMin: 1000 });
});

test("non-integers fall back to the default instead of being rounded", () => {
  assert.equal(normalizeSettings({ feePercent: 7.5 }).feePercent, 10);
  assert.equal(normalizeSettings({ feePercent: "12" }).feePercent, 12);
});

test("rate limits are whole thousands and min never exceeds max", () => {
  const s = normalizeSettings({ minRateVnd: 33_333, maxRateVnd: 20_000 });
  assert.equal(s.minRateVnd % 1000, 0);
  assert.equal(s.maxRateVnd % 1000, 0);
  assert.ok(s.minRateVnd <= s.maxRateVnd);
  const t = normalizeSettings({ minRateVnd: 50_000, maxRateVnd: 50_000 });
  assert.equal(t.minRateVnd, 50_000);
  assert.equal(t.maxRateVnd, 50_000);
});

test("cancellation tiers are rebuilt: sorted, deduplicated, never rising, and always ending at zero hours", () => {
  const s = normalizeSettings({ cancellation: [{ minHoursBefore: 2, refundPercent: 80 }, { minHoursBefore: 48, refundPercent: 100 }, { minHoursBefore: 2, refundPercent: 10 }, { minHoursBefore: "x", refundPercent: 5 }] });
  assert.deepEqual(s.cancellation, [
    { minHoursBefore: 48, refundPercent: 100 },
    { minHoursBefore: 2, refundPercent: 80 },
    { minHoursBefore: 0, refundPercent: 0 },
  ]);
  const rising = normalizeSettings({ cancellation: [{ minHoursBefore: 24, refundPercent: 30 }, { minHoursBefore: 0, refundPercent: 90 }] });
  assert.deepEqual(rising.cancellation.map((t) => t.refundPercent), [30, 30], "a closer deadline can never refund more");
  assert.equal(normalizeSettings({ cancellation: [] }).cancellation.length, 3);
  assert.equal(normalizeSettings({ cancellation: "nope" }).cancellation.length, 3);
});

test("ids must look like Discord snowflakes, text is trimmed and cut", () => {
  const s = normalizeSettings({
    ownerNotes: `  ${"a".repeat(2000)}  `,
    channels: { rulesChannelId: "123456789012345678", guideChannelId: "abc", playersChannelId: 5 },
    roles: { staffRoleId: "223456789012345678", playerRoleId: "12" },
  });
  assert.equal(s.ownerNotes.length, 1000);
  assert.equal(s.channels.rulesChannelId, "123456789012345678");
  assert.equal(s.channels.guideChannelId, null);
  assert.equal(s.channels.playersChannelId, null);
  assert.equal(s.roles.staffRoleId, "223456789012345678");
  assert.equal(s.roles.playerRoleId, null);
});

test("an unknown time zone falls back", () => {
  assert.equal(normalizeSettings({ timezone: "Mars/Base" }).timezone, "Asia/Ho_Chi_Minh");
  assert.equal(normalizeSettings({ timezone: "Europe/Paris" }).timezone, "Europe/Paris");
  assert.equal(normalizeSettings({ timezone: "Mars/Base" }, "Asia/Tokyo").timezone, "Asia/Tokyo");
});

test("normalizing twice changes nothing", () => {
  const once = normalizeSettings({ feePercent: 15, cancellation: [{ minHoursBefore: 12, refundPercent: 70 }] });
  assert.deepEqual(normalizeSettings(once), once);
});

test("settings are stored as one document and patches merge nested keys", () => {
  assert.equal(getSettings().feePercent, 10);
  saveSettings({ feePercent: 20 });
  assert.equal(getSettings().feePercent, 20);
  patchSettings({ channels: { rulesChannelId: "123456789012345678" } });
  patchSettings({ channels: { guideChannelId: "223456789012345678" }, feePercent: 12 });
  const s = getSettings();
  assert.equal(s.channels.rulesChannelId, "123456789012345678");
  assert.equal(s.channels.guideChannelId, "223456789012345678");
  assert.equal(s.feePercent, 12);
});

test("a damaged stored row never leaks a bad value", async () => {
  const { getDb } = await import("../src/db.js");
  getDb().prepare("INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES (1, ?, 0)").run("{not json");
  assert.equal(getSettings().feePercent, 10);
  getDb().prepare("INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES (1, ?, 0)").run(JSON.stringify({ feePercent: 9999 }));
  assert.equal(getSettings().feePercent, 50);
});

test("config requires token, client id and server id, and checks them", () => {
  assert.deepEqual(readConfig({}).missing, ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"]);
  assert.deepEqual(readConfig({ DISCORD_TOKEN: "x", CLIENT_ID: "1", GUILD_ID: "123456789012345678" }).missing, []);
  assert.equal(readConfig({ DISCORD_TOKEN: "x", CLIENT_ID: "1", GUILD_ID: "abc" }).problems.length, 1);
  assert.equal(readConfig({ DISCORD_TOKEN: "x", CLIENT_ID: "1", GUILD_ID: "123456789012345678", TIMEZONE: "Mars/Base" }).problems.length, 1);
});

test("config defaults and parsing", () => {
  const base = { DISCORD_TOKEN: "x", CLIENT_ID: "1", GUILD_ID: "123456789012345678" };
  const { config } = readConfig({ ...base, OWNER_IDS: " 1, 2 ,,3 ", PAYOS_CLIENT_ID: "a" });
  assert.equal(config.timezone, "Asia/Ho_Chi_Minh");
  assert.equal(config.dataDir, "data");
  assert.deepEqual(config.ownerIds, ["1", "2", "3"]);
  assert.equal(config.payos.apiKey, null);
  assert.equal(config.alertWebhookUrl, null);
  assert.equal(readConfig({ ...base, TIMEZONE: "Europe/Paris" }).config.timezone, "Europe/Paris");
});
