import { NOW, HOUR, MIN, DAY, vn, makePlayer, makeCustomer, confirmed, book, ledgerRows, getDb, getSettings, saveSettings } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, modalOf, buttonIds, lastPayload, P } from "./discord-fakes.js";
import { config } from "../src/config.js";
import { cancel, complete, staffActor, SYSTEM, getBooking, start } from "../src/domain/bookings.js";
import { getPlayer } from "../src/domain/players.js";
import { isBlacklisted, listStrikes, activeStrikeCount } from "../src/domain/strikes.js";
import { getLedgerRow } from "../src/domain/ledger.js";
import { runRoles } from "../src/jobs/roles.js";
import { runCards } from "../src/jobs/cards.js";
import { runDigest } from "../src/jobs/digest.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { kvGet } from "../src/kv.js";
import { createBookingOrder } from "../src/pay/orders.js";

let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
});

const owed = (bookingId, kind) => ledgerRows(bookingId).find((r) => r.kind === kind);

// ---------------------------------------------------------------- the money queue

// One refund (player cancelled), one payout that may be sent (finished long ago), one payout still held (finished just now)
function moneySetup() {
  const refunded = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  cancel(refunded.id, { role: "player", userId: IDS.player }, NOW);
  const old = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR });
  start(old.id, SYSTEM, NOW + 2 * HOUR);
  complete(old.id, SYSTEM, NOW + 3 * HOUR);
  const recent = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 4 * HOUR });
  start(recent.id, SYSTEM, NOW + 4 * HOUR);
  complete(recent.id, SYSTEM, NOW + 5 * HOUR);
  return { refunded, old, recent, clock: NOW + 28 * HOUR };
}

test("/chuyentien is for owners only", async () => {
  moneySetup();
  for (const user of [IDS.rando, IDS.cust, IDS.player, IDS.staff]) {
    const i = await env.command(user, "chuyentien");
    assert.match(textOf(i), /không có quyền/);
    assert.equal(i.out.some((o) => o.payload?.embeds), false, "no money data is shown");
  }
  const i = await env.command(IDS.owner, "chuyentien");
  assert.match(textOf(i), /Việc chuyển tiền/);
});

test("the queue lists refunds, payable payouts grouped by player and held payouts apart, with the buttons the design names", async () => {
  const { refunded, old, recent, clock } = moneySetup();
  setClock(() => clock);
  saveSettings({ ...getSettings(), ownerNotes: "Chuyển khoản vào thứ Sáu" });
  const i = await env.command(IDS.owner, "chuyentien");
  const main = i.out.find((o) => o.type === "edit").payload;
  const text = textOf({ out: [{ payload: main }] });
  assert.match(text, new RegExp(`Hoàn tiền cần gửi \\(1\\)[\\s\\S]*#${owed(refunded.id, "REFUND").id} \\| 100\\.000 đ cho <@${IDS.cust}>`));
  assert.match(text, new RegExp(`<@${IDS.player}>: chuyển ngay 90\\.000 đ \\(tổng đang nợ kể cả phần giữ: 180\\.000 đ\\)`));
  assert.match(text, /Chuyển khoản vào thứ Sáu/);
  assert.match(text, /Sổ cái/);
  const ids = buttonIds(main);
  assert.deepEqual(ids, [`mn:paid:${owed(refunded.id, "REFUND").id}`, `mn:paid:${owed(old.id, "PLAYER_PAYOUT").id}`]);

  const none = await env.command(IDS.owner, "chuyentien");
  assert.ok(none);
});

test("a held payout is listed only in a separate message and only with a force button", async () => {
  const { old, recent } = moneySetup();
  setClock(() => NOW + 5 * HOUR + 2 * HOUR);
  const i = await env.command(IDS.owner, "chuyentien");
  const follow = i.out.find((o) => o.type === "followUp").payload;
  assert.match(textOf({ out: [{ payload: follow }] }), /Đang giữ trong thời gian khiếu nại/);
  assert.match(textOf({ out: [{ payload: follow }] }), /Đang giữ đến/);
  assert.deepEqual(buttonIds(follow).sort(), [`mn:force:${owed(old.id, "PLAYER_PAYOUT").id}`, `mn:force:${owed(recent.id, "PLAYER_PAYOUT").id}`].sort());
  const main = i.out.find((o) => o.type === "edit").payload;
  assert.equal(buttonIds(main).some((id) => id.startsWith("mn:force")), false);
  assert.equal(buttonIds(main).some((id) => id === `mn:paid:${owed(recent.id, "PLAYER_PAYOUT").id}`), false, "no ordinary button for held money");
});

test("marking paid: owner only, confirm first, recorded with who and when, logged, the person told, and a second confirm changes nothing", async () => {
  const { refunded, clock } = moneySetup();
  setClock(() => clock);
  const row = owed(refunded.id, "REFUND");
  for (const user of [IDS.rando, IDS.staff, IDS.player, IDS.cust]) {
    assert.match(textOf(await env.click(user, `mn:paid:${row.id}`)), /không có quyền/);
    assert.match(textOf(await env.click(user, `mn:paid:yes:${row.id}`)), /không có quyền/);
  }
  assert.equal(getLedgerRow(row.id).status, "OWED");

  const ask = await env.click(IDS.owner, `mn:paid:${row.id}`);
  assert.match(textOf(ask), new RegExp(`Xác nhận bạn đã chuyển 100\\.000 đ \\(hoàn tiền cho khách\\) cho <@${IDS.cust}>, lịch #${refunded.id}\\?`));
  assert.equal(getLedgerRow(row.id).status, "OWED", "asking marks nothing");

  const yes = await env.click(IDS.owner, `mn:paid:yes:${row.id}`);
  assert.match(textOf(yes), /Đã ghi nhận chuyển 100\.000 đ/);
  const after = getLedgerRow(row.id);
  assert.equal(after.status, "PAID");
  assert.equal(after.paid_by, IDS.owner);
  assert.equal(after.paid_at, clock);
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, new RegExp(`Đã chuyển 100\\.000 đ \\(hoàn tiền cho khách\\) cho <@${IDS.cust}>.*<@${IDS.owner}>`));
  assert.match(dms(env.client, IDS.cust).join("\n"), /Chủ server đã chuyển lại 100\.000 đ cho bạn/);

  const logs = env.channel("moneyLogChannelId").sent.length;
  const again = await env.click(IDS.owner, `mn:paid:yes:${row.id}`);
  assert.match(textOf(again), /đã được đánh dấu đã chuyển trước đó, không thay đổi gì/);
  assert.equal(env.channel("moneyLogChannelId").sent.length, logs, "no second log line");
  assert.match(textOf(await env.click(IDS.owner, `mn:paid:${row.id}`)), /đã được đánh dấu đã chuyển rồi/);
  assert.match(textOf(await env.click(IDS.owner, "mn:paid:99999")), /Không tìm thấy khoản tiền/);
});

test("a held payout cannot be marked with the ordinary button; forcing needs a second confirmation naming the amount and is logged as forced", async () => {
  const { recent } = moneySetup();
  setClock(() => NOW + 5 * HOUR + 2 * HOUR);
  const row = owed(recent.id, "PLAYER_PAYOUT");
  assert.match(textOf(await env.click(IDS.owner, `mn:paid:yes:${row.id}`)), /còn trong thời gian chờ khiếu nại/);
  assert.equal(getLedgerRow(row.id).status, "OWED");

  const warn = await env.click(IDS.owner, `mn:force:${row.id}`);
  assert.match(textOf(warn), /CẢNH BÁO/);
  assert.match(textOf(warn), /90\.000 đ/);
  assert.deepEqual(buttonIds(lastPayload(warn)), [`mn:force:yes:${row.id}`]);
  assert.match(lastPayload(warn).components[0].toJSON().components[0].label, /Ép trả 90\.000 đ/);
  assert.equal(getLedgerRow(row.id).status, "OWED");

  for (const user of [IDS.staff, IDS.player]) assert.match(textOf(await env.click(user, `mn:force:yes:${row.id}`)), /không có quyền/);
  assert.equal(getLedgerRow(row.id).status, "OWED");
  const done = await env.click(IDS.owner, `mn:force:yes:${row.id}`);
  assert.match(textOf(done), /Đã ghi nhận chuyển 90\.000 đ/);
  assert.equal(getLedgerRow(row.id).status, "PAID");
  assert.equal(getLedgerRow(row.id).note, "ép trả sớm");
  assert.match(env.channel("moneyLogChannelId").sent.at(-1).content, /Ép trả sớm: Đã chuyển 90\.000 đ/);
});

test("a payout with an open dispute is not offered and cannot be marked", async () => {
  const { old } = moneySetup();
  const { openDispute } = await import("../src/domain/bookings.js");
  openDispute(old.id, staffActor("s"), "x", NOW + 6 * HOUR);
  setClock(() => NOW + 3 * DAY);
  const i = await env.command(IDS.owner, "chuyentien");
  assert.equal(buttonIds(i.out.find((o) => o.type === "edit").payload).includes(`mn:paid:${owed(old.id, "PLAYER_PAYOUT").id}`), false);
  assert.match(textOf(await env.click(IDS.owner, `mn:paid:yes:${owed(old.id, "PLAYER_PAYOUT").id}`)), /đang có khiếu nại chưa xử lý/);
});

// ---------------------------------------------------------------- staff commands

const STAFF_SUBS = [
  ["duyet", {}],
  ["khieu-nai", {}],
  ["huy-lich", { id: 1 }],
  ["phat", { user: { id: IDS.cust }, "ly-do": "x" }],
  ["mo-khoa", { user: { id: IDS.player } }],
  ["cam", { user: { id: IDS.cust }, "ly-do": "x" }],
  ["bo-cam", { user: { id: IDS.cust } }],
  ["tong-ket", {}],
];

test("every /staff subcommand and /admin subcommand refuses ordinary people, players and customers", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  for (const user of [IDS.rando, IDS.cust, IDS.player]) {
    for (const [subcommand, opts] of STAFF_SUBS) {
      const i = await env.command(user, "staff", { subcommand, opts });
      assert.match(textOf(i), /không có quyền/, `${subcommand} for ${user}`);
    }
    for (const subcommand of ["cai-dat", "sao-luu", "donhang"]) {
      const i = await env.command(user, "admin", { subcommand, opts: { nhom: "phi" } });
      assert.match(textOf(i), /không có quyền/, `admin ${subcommand}`);
      assert.equal(modalOf(i), undefined);
    }
  }
  assert.equal(getBooking(b.id).status, "CONFIRMED");
  assert.equal(isBlacklisted(IDS.cust), false);
  assert.equal(listStrikes(IDS.cust).length, 0);
  // staff are not owners
  for (const subcommand of ["cai-dat", "sao-luu", "donhang"]) assert.match(textOf(await env.command(IDS.staff, "admin", { subcommand, opts: { nhom: "phi" } })), /không có quyền/);
});

test("/staff duyet and /staff khieu-nai list the queues with the decision buttons", async () => {
  assert.match(textOf(await env.command(IDS.staff, "staff", { subcommand: "duyet" })), /Không có hồ sơ nào/);
  assert.match(textOf(await env.command(IDS.staff, "staff", { subcommand: "khieu-nai" })), /Không có khiếu nại nào/);
  const { attest } = await import("../src/domain/attestations.js");
  const { applyAsPlayer } = await import("../src/domain/players.js");
  attest(IDS.player2, NOW);
  applyAsPlayer({ userId: IDS.player2, displayName: "Lan", games: ["LoL"], rateVnd: 80_000, bio: "", languages: "" }, NOW);
  const list = await env.command(IDS.staff, "staff", { subcommand: "duyet" });
  assert.deepEqual(buttonIds(lastPayload(list)), [`pl:approve:${IDS.player2}`, `pl:reject:${IDS.player2}`]);

  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR });
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  const { openDispute } = await import("../src/domain/bookings.js");
  openDispute(b.id, staffActor("s"), "lỗi", NOW + 2 * HOUR + MIN);
  const disputes = await env.command(IDS.staff, "staff", { subcommand: "khieu-nai" });
  assert.deepEqual(buttonIds(lastPayload(disputes)), ["dp:resolve:1:pay_player", "dp:resolve:1:refund_customer", "dp:resolve:1:split"]);
});

test("/staff huy-lich cancels with a full refund and says how much", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 3 * HOUR });
  const i = await env.command(IDS.staff, "staff", { subcommand: "huy-lich", opts: { id: b.id, "ly-do": "Khách yêu cầu @everyone" } });
  assert.match(textOf(i), /Đã huỷ lịch #1, hoàn 100\.000 đ cho khách\./);
  assert.equal(getBooking(b.id).status, "CANCELLED");
  assert.equal(getBooking(b.id).cancelled_by, "staff");
  assert.equal(owed(b.id, "REFUND").amount_vnd, 100_000);
  assert.ok(!/everyone/.test(owed(b.id, "REFUND").note ?? ""));
  assert.match(dms(env.client, IDS.cust).join("\n"), /đã bị huỷ\. Khoản hoàn 100\.000 đ/);
  assert.match(textOf(await env.command(IDS.staff, "staff", { subcommand: "huy-lich", opts: { id: 99 } })), /Không tìm thấy lịch/);
  assert.match(textOf(await env.command(IDS.staff, "staff", { subcommand: "huy-lich", opts: { id: b.id } })), /không thể thực hiện/);
});

test("/staff phat adds strikes and suspends a player on the third; /staff mo-khoa lifts it and restores the role", async () => {
  env.guild.members.cache.get(IDS.player).roles.cache.set(env.role("playerRoleId"), { id: env.role("playerRoleId") });
  for (const [n, reason] of ["a", "b", "c"].entries()) {
    const i = await env.command(IDS.staff, "staff", { subcommand: "phat", opts: { user: { id: IDS.player }, "ly-do": `lý do ${reason} @everyone` } });
    assert.match(textOf(i), new RegExp(`hiện có ${n + 1} cảnh cáo`));
    if (n === 2) assert.match(textOf(i), /Player đã bị tạm khoá/);
  }
  assert.equal(getPlayer(IDS.player).status, "SUSPENDED");
  assert.equal(env.guild.members.cache.get(IDS.player).roles.cache.has(env.role("playerRoleId")), false);
  assert.ok(listStrikes(IDS.player).every((s) => !/everyone/.test(s.reason)));
  assert.match(env.channel("playersChannelId").sent[0].embeds[0].footer.text, /Tạm khoá/);

  const lifted = await env.command(IDS.staff, "staff", { subcommand: "mo-khoa", opts: { user: { id: IDS.player } } });
  assert.match(textOf(lifted), /Đã mở khoá Player 900000000000000005/);
  assert.equal(getPlayer(IDS.player).status, "ACTIVE");
  assert.equal(activeStrikeCount(IDS.player, NOW), 0);
  assert.equal(env.guild.members.cache.get(IDS.player).roles.cache.has(env.role("playerRoleId")), true);
  assert.match(textOf(await env.command(IDS.staff, "staff", { subcommand: "mo-khoa", opts: { user: { id: IDS.player } } })), /Không tìm thấy/);
});

test("/staff cam blacklists (and suspends a player), refuses staff, owners, bots and self, and offers to cancel upcoming bookings; bo-cam lifts it", async () => {
  confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  const ban = (user, extra = {}) => env.command(IDS.staff, "staff", { subcommand: "cam", opts: { user: { id: user, ...extra }, "ly-do": "Vi phạm luật" } });
  assert.match(textOf(await ban(IDS.staff)), /Không thể cấm người này/);
  assert.match(textOf(await ban(IDS.owner)), /Không thể cấm nhân viên hoặc chủ server/);
  assert.match(textOf(await ban("900000000000000050", { bot: true })), /./);
  const other = env.guild.addMember({ id: IDS.rando, roles: [env.role("staffRoleId")] });
  assert.match(textOf(await ban(other.id)), /Không thể cấm nhân viên/);
  assert.equal(isBlacklisted(IDS.rando), false);

  const banned = await ban(IDS.player);
  assert.match(textOf(banned), new RegExp(`Đã cấm <@${IDS.player}>\\. Người này còn 1 lịch sắp tới`));
  assert.deepEqual(buttonIds(lastPayload(banned)), [`dp:cancelupcoming:${IDS.player}`]);
  assert.equal(isBlacklisted(IDS.player), true);
  assert.equal(getPlayer(IDS.player).status, "SUSPENDED");
  assert.match(env.channel("playersChannelId").sent[0].embeds[0].footer.text, /Tạm khoá/);
  // a banned player is refused everywhere
  assert.match(textOf(await env.command(IDS.player, "thunhap")), /không được phép/);

  const bannedCustomer = await ban(IDS.cust);
  assert.equal(isBlacklisted(IDS.cust), true);
  assert.doesNotMatch(textOf(bannedCustomer), /lịch sắp tới/);
  const lifted = await env.command(IDS.staff, "staff", { subcommand: "bo-cam", opts: { user: { id: IDS.cust } } });
  assert.match(textOf(lifted), /Đã bỏ cấm/);
  assert.equal(isBlacklisted(IDS.cust), false);
  assert.match(textOf(await env.command(IDS.staff, "staff", { subcommand: "bo-cam", opts: { user: { id: IDS.cust } } })), /không nằm trong danh sách cấm/);
  assert.match(env.channel("bookingsLogChannelId").sent.at(-1).content, /bỏ cấm/);
});

test("/staff tong-ket shows today, the next days, the week's money and what waits", async () => {
  moneySetup();
  confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 6 * HOUR + 3 * HOUR });
  setClock(() => NOW + 5 * HOUR + 30 * MIN);
  const i = await env.command(IDS.staff, "staff", { subcommand: "tong-ket" });
  const text = textOf(i);
  for (const part of ["Tổng kết", "Hôm nay", "7 ngày tới", "Doanh thu trong kỳ", "Hồ sơ chờ duyệt", "Khiếu nại đang mở", "Việc chuyển tiền", "Hoàn tiền khách: 1 khoản, 100.000 đ"]) assert.ok(text.includes(part), part);
  assert.equal(await env.command(IDS.owner, "staff", { subcommand: "tong-ket" }).then((x) => x.out.length > 0), true, "an owner passes the staff gate");
});

// ---------------------------------------------------------------- /admin

test("/admin cai-dat: each group opens a form with the current values, saves clamped numbers and explains bad input", async () => {
  const open = await env.command(IDS.owner, "admin", { subcommand: "cai-dat", opts: { nhom: "phi" } });
  const fields = modalOf(open).toJSON().components.map((r) => r.components[0]);
  assert.deepEqual(fields.map((f) => f.custom_id), ["feePercent", "maxDurationHours", "maxActiveBookings", "minRateVnd", "maxRateVnd"]);
  assert.equal(fields[0].value, "10");

  const saved = await env.submit(IDS.owner, "ad:settings:phi", { feePercent: "15", maxDurationHours: "3", maxActiveBookings: "2", minRateVnd: "30.000", maxRateVnd: "400000" });
  assert.match(textOf(saved), /Đã lưu cài đặt/);
  assert.match(textOf(saved), /Lịch đã tạo giữ nguyên giá và phí cũ/);
  const s = getSettings();
  assert.deepEqual([s.feePercent, s.maxDurationHours, s.maxActiveBookings, s.minRateVnd, s.maxRateVnd], [15, 3, 2, 30_000, 400_000]);
  assert.equal(getSettings().channels.rulesChannelId !== null, true, "ids survive a settings change");

  const clamped = await env.submit(IDS.owner, "ad:settings:phi", { feePercent: "99", maxDurationHours: "3", maxActiveBookings: "2", minRateVnd: "30000", maxRateVnd: "400000" });
  assert.equal(getSettings().feePercent, 50);
  assert.match(textOf(clamped), /Phí nền tảng \(%\): 50/);
  assert.match(textOf(await env.submit(IDS.owner, "ad:settings:phi", { feePercent: "mười", maxDurationHours: "3", maxActiveBookings: "2", minRateVnd: "30000", maxRateVnd: "400000" })), /phải là số nguyên/);
  assert.equal(getSettings().feePercent, 50);

  assert.deepEqual(modalOf(await env.command(IDS.owner, "admin", { subcommand: "cai-dat", opts: { nhom: "thoigian" } })).toJSON().components.length, 5);
  await env.submit(IDS.owner, "ad:settings:thoigian", { minLeadMin: "90", maxAdvanceDays: "14", unpaidExpireMin: "20", noShowGraceMin: "10", reviewWindowHours: "12" });
  assert.deepEqual([getSettings().minLeadMin, getSettings().maxAdvanceDays, getSettings().unpaidExpireMin, getSettings().noShowGraceMin, getSettings().reviewWindowHours], [90, 14, 20, 10, 12]);
});

test("/admin cai-dat huy: cancellation tiers are read from lines and bad lines are explained", async () => {
  const form = await env.command(IDS.owner, "admin", { subcommand: "cai-dat", opts: { nhom: "huy" } });
  assert.equal(modalOf(form).toJSON().components[0].components[0].value, "24h 100\n2h 50\n0h 0");
  const ok = await env.submit(IDS.owner, "ad:settings:huy", { cancellation: "48h 100\n12 80%\n0h 20", ownerNotes: "Thứ Sáu hằng tuần @everyone" });
  assert.deepEqual(getSettings().cancellation, [{ minHoursBefore: 48, refundPercent: 100 }, { minHoursBefore: 12, refundPercent: 80 }, { minHoursBefore: 0, refundPercent: 20 }]);
  assert.ok(!/everyone/.test(getSettings().ownerNotes));
  assert.match(textOf(ok), /từ 48 giờ trở lên: hoàn 100%/);
  const bad = await env.submit(IDS.owner, "ad:settings:huy", { cancellation: "một ngày trước thì hoàn hết", ownerNotes: "" });
  assert.match(textOf(bad), /chưa đúng\. Mỗi dòng một mức/);
  assert.equal(getSettings().cancellation.length, 3);
  assert.match(textOf(await env.submit(IDS.staff, "ad:settings:huy", { cancellation: "0h 0", ownerNotes: "" })), /không có quyền/);
  assert.equal(getSettings().cancellation.length, 3);
});

test("/admin sao-luu writes today's backup once, /admin donhang lists recent orders", async () => {
  const before = config.dataDir;
  config.dataDir = mkdtempSync(path.join(tmpdir(), "booking-admin-"));
  try {
    const first = await env.command(IDS.owner, "admin", { subcommand: "sao-luu" });
    assert.match(textOf(first), /Đã sao lưu: thauxbooking-2026-10-05\.db/);
    assert.ok(existsSync(path.join(config.dataDir, "backups", "thauxbooking-2026-10-05.db")));
    assert.match(textOf(await env.command(IDS.owner, "admin", { subcommand: "sao-luu" })), /Hôm nay đã có bản sao lưu/);
  } finally {
    config.dataDir = before;
  }
  assert.match(textOf(await env.command(IDS.owner, "admin", { subcommand: "donhang" })), /Chưa có đơn thanh toán nào/);
  const b = book({ customerId: IDS.cust, playerId: IDS.player });
  createBookingOrder(b.id, NOW);
  const list = textOf(await env.command(IDS.owner, "admin", { subcommand: "donhang" }));
  assert.match(list, /lịch #1 .* 100\.000 đ \| PENDING/);
});

// ---------------------------------------------------------------- daily jobs

function seedTrust() {
  getDb().prepare("UPDATE players SET completed = 10, rating_sum = 47, rating_count = 10 WHERE user_id = ?").run(IDS.player);
  const insert = getDb().prepare(
    "INSERT INTO bookings (customer_id, player_id, game, start_at, duration_min, price_vnd, fee_vnd, status, created_at, ended_at) VALUES (?, ?, 'LoL', ?, 60, 100000, 10000, 'COMPLETED', ?, ?)",
  );
  for (let n = 0; n < 5; n += 1) insert.run(IDS.cust, IDS.player, NOW - (n + 2) * DAY, NOW - (n + 3) * DAY, NOW - (n + 2) * DAY + HOUR);
}
const holds = (id, key) => env.guild.members.cache.get(id)?.roles.cache.has(env.role(key));

test("the daily roles job grants Trusted and Khách quen from the facts, removes them when the facts change, and fetches members one by one", async () => {
  seedTrust();
  let fetched = 0;
  const original = env.guild.members.fetch;
  env.guild.members.fetch = async (id) => (fetched += 1, original(id));
  const result = await runRoles(env.client);
  assert.deepEqual(result, { granted: 2, removed: 0 });
  assert.equal(holds(IDS.player, "trustedPlayerRoleId"), true);
  assert.equal(holds(IDS.cust, "regularCustomerRoleId"), true);
  assert.equal(holds(IDS.cust, "trustedPlayerRoleId"), false);
  assert.equal(holds(IDS.player, "regularCustomerRoleId"), false);
  assert.ok(fetched >= 2 && fetched <= 4, `members were fetched by id (${fetched} calls)`);
  assert.equal(typeof env.guild.members.list, "undefined", "no member listing exists to call");

  assert.deepEqual(await runRoles(env.client), { granted: 0, removed: 0 }, "idempotent");

  getDb().prepare("UPDATE players SET rating_sum = 30 WHERE user_id = ?").run(IDS.player);
  getDb().prepare("UPDATE bookings SET status = 'CANCELLED' WHERE id <= 2").run();
  const later = await runRoles(env.client);
  assert.equal(later.removed, 2);
  assert.equal(holds(IDS.player, "trustedPlayerRoleId"), false);
  assert.equal(holds(IDS.cust, "regularCustomerRoleId"), false);
});

test("the roles job skips people who left, leaves a role given by hand to a non-candidate alone, and never grants a dangerous role", async () => {
  seedTrust();
  env.guild.members.cache.delete(IDS.cust);
  const hand = env.guild.addMember({ id: IDS.rando });
  hand.roles.cache.set(env.role("trustedPlayerRoleId"), { id: env.role("trustedPlayerRoleId") });
  const result = await runRoles(env.client);
  assert.deepEqual(result, { granted: 1, removed: 0 });
  assert.equal(hand.roles.cache.has(env.role("trustedPlayerRoleId")), true);

  env.guild.roles.cache.get(env.role("regularCustomerRoleId")).permissions.flags.add(P.BanMembers);
  env.guild.addMember({ id: IDS.cust });
  const again = await runRoles(env.client);
  assert.equal(again.granted, 0);
  assert.equal(holds(IDS.cust, "regularCustomerRoleId"), false);
});

test("the roles job without a guild does nothing", async () => {
  assert.deepEqual(await runRoles({}), { granted: 0, removed: 0 });
});

test("the daily cards job refreshes cards and the guide in place", async () => {
  getDb().prepare("UPDATE players SET rate_vnd = 120000 WHERE user_id = ?").run(IDS.player);
  saveSettings({ ...getSettings(), cancellation: [{ minHoursBefore: 48, refundPercent: 100 }, { minHoursBefore: 0, refundPercent: 10 }] });
  const result = await runCards(env.client);
  assert.equal(result.cards, 1);
  const card = env.channel("playersChannelId").sent[0];
  assert.ok(card.embeds[0].fields.some((f) => /120\.000/.test(f.value)));
  assert.equal(env.channel("playersChannelId").sent.length, 1, "edited, not reposted");
  const guide = env.channel("guideChannelId").sent[0];
  assert.match(guide.embeds[0].description, /từ 48 giờ trở lên: hoàn 100%/);
  assert.equal(env.channel("guideChannelId").sent.length, 1);
});

test("a deleted card is posted again", async () => {
  const card = env.channel("playersChannelId").sent[0];
  card.deleted = true;
  await runCards(env.client);
  assert.equal(env.channel("playersChannelId").sent.length, 2);
  assert.equal(getPlayer(IDS.player).profileMessageId, env.channel("playersChannelId").sent[1].id);
});

test("the owner digest: weekly on Monday morning, daily after, once per local date, never before 08:00, only in the owner channel", async () => {
  const money = env.channel("moneyLogChannelId");
  assert.equal(await runDigest(env.client, { now: vn(2026, 10, 5, 7, 59) }), null);
  assert.equal(await runDigest(env.client, { now: vn(2026, 10, 5, 8, 0) }), "weekly");
  assert.equal(money.sent.length, 1);
  assert.match(JSON.stringify(money.sent[0].embeds), /Tổng kết tuần/);
  assert.equal(await runDigest(env.client, { now: vn(2026, 10, 5, 12, 0) }), null, "once per date");
  assert.equal(kvGet("digest:weekly"), "2026-10-05");
  assert.equal(await runDigest(env.client, { now: vn(2026, 10, 6, 9, 0) }), "daily");
  assert.match(JSON.stringify(money.sent[1].embeds), /Tóm tắt buổi sáng/);
  assert.equal(await runDigest(env.client, { now: vn(2026, 10, 6, 21, 0) }), null);
  assert.equal(await runDigest(env.client, { now: vn(2026, 10, 7, 9, 0) }), "daily");
  assert.equal(env.channel("bookingsLogChannelId").sent.filter((m) => m.embeds?.length).length, 0);
  assert.equal(await runDigest({}, { now: vn(2026, 10, 8, 9, 0) }), null);
});

test("a digest that could not be posted is tried again", async () => {
  const money = env.channel("moneyLogChannelId");
  money.failSend = true;
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await runDigest(env.client, { now: vn(2026, 10, 6, 9, 0) }), null);
  } finally {
    console.error = original;
  }
  assert.equal(kvGet("digest:daily"), null);
  money.failSend = false;
  assert.equal(await runDigest(env.client, { now: vn(2026, 10, 6, 9, 5) }), "daily");
});
