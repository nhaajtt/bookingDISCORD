import { NOW, HOUR, MIN, makePlayer, makeCustomer, getDb } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, buttonIds, lastPayload } from "./discord-fakes.js";
import { config } from "../src/config.js";
import { checkPayments } from "../src/jobs/payments.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { getBooking } from "../src/domain/bookings.js";
import { setBank } from "../src/domain/bank.js";
import { walletBalance } from "../src/domain/wallet.js";
import { ledgerRows } from "./helpers.js";
import { defaultProvider, enabledProviders } from "../src/pay/gateway.js";
import { manualDetails, manualEnabled } from "../src/pay/manual.js";
import { getOrder } from "../src/pay/orders.js";

let env;
const saved = {};
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player, { rateVnd: 100_000 });
  makeCustomer(IDS.cust);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
  // Only bank transfer is on: no payOS keys, the way the owner runs it
  Object.assign(saved, { payos: { ...config.payos }, provider: config.paymentProvider });
  Object.assign(config.payos, { clientId: null, apiKey: null, checksumKey: null });
  config.paymentProvider = null;
});
afterEach(() => {
  Object.assign(config.payos, saved.payos);
  config.paymentProvider = saved.provider;
  setClock(() => NOW);
});

const form = { game: "liên quân", when: "05/10 19:00", duration: "1" };
const receive = () => setBank("owner", { bank: "MB", accountNo: "0123456789", accountName: "Nguyen Van A" }, NOW);
const tick = (t = NOW) => checkPayments(env.client, t);
const owed = () => env.channel("moneyLogChannelId").sent;

test("bank transfer is a payment method only once the owner has saved a receiving account", () => {
  assert.equal(manualEnabled(), false);
  assert.deepEqual(enabledProviders(), []);
  receive();
  assert.equal(manualEnabled(), true);
  assert.deepEqual(enabledProviders(), ["manual"]);
  assert.equal(defaultProvider(), "manual");
});

test("the owner sets the receiving account with /admin nhan-tien, and nobody else can", async () => {
  assert.match(textOf(await env.command(IDS.cust, "admin", { subcommand: "nhan-tien" })), /không có quyền/);
  const open = await env.command(env.owner, "admin", { subcommand: "nhan-tien" });
  const fields = open.out.find((o) => o.modal).modal.toJSON().components.map((r) => r.components[0].custom_id);
  assert.deepEqual(fields, ["bank", "accountNo", "accountName"]);
  const done = await env.submit(env.owner, "ad:receive", { bank: "mb", accountNo: "0123 456 789", accountName: "Nguyễn Văn A" });
  assert.match(textOf(done), /MB Bank 0123456789 NGUYEN VAN A/);
  assert.equal(manualEnabled(), true);
  const bad = await env.submit(env.owner, "ad:receive", { bank: "khong co", accountNo: "1", accountName: "A" });
  assert.match(textOf(bad), /Không nhận ra ngân hàng/);
});

test("a booking by transfer shows the account, the QR and the note, and waits for the owner", async () => {
  receive();
  const made = await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  const payload = lastPayload(made);
  const embed = payload.embeds[0].toJSON();
  assert.match(embed.fields.find((f) => f.name === "Chuyển khoản").value, /MB Bank 0123456789 \(NGUYEN VAN A\), nội dung: BOOK\d{5}/);
  const row = payload.components[0].toJSON().components;
  assert.match(row[0].url, /^https:\/\/img\.vietqr\.io\/image\/970422-0123456789-compact2\.png\?amount=100000&addInfo=BOOK\d{5}/);
  assert.equal(row[0].label, "Xem mã QR");
  assert.deepEqual(buttonIds(payload), ["mp:told:" + getOrder(getDb().prepare("SELECT order_code FROM orders").get().order_code).order_code, "bk:cancel:1"]);

  await tick(NOW + MIN);
  assert.equal(getBooking(1).status, "AWAITING_PAYMENT", "nothing is confirmed on its own");
  const notice = owed().at(-1);
  assert.match(JSON.stringify(notice.embeds), /Chờ chuyển khoản/);
  const code = getDb().prepare("SELECT order_code FROM orders").get().order_code;
  assert.deepEqual(buttonIds({ components: notice.components }), [`mp:ok:${code}`]);
  await tick(NOW + 2 * MIN);
  assert.equal(owed().filter((m) => /Chờ chuyển khoản/.test(JSON.stringify(m.embeds ?? []))).length, 1, "the owner is told once");
});

test("the owner confirms: the booking is paid, both people are told, and a second press changes nothing", async () => {
  receive();
  await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  await tick(NOW + MIN);
  const code = getDb().prepare("SELECT order_code FROM orders").get().order_code;
  assert.match(textOf(await env.click(IDS.cust, `mp:ok:${code}`)), /không có quyền/);
  assert.equal(getBooking(1).status, "AWAITING_PAYMENT");
  setClock(() => NOW + 3 * MIN);
  assert.match(textOf(await env.click(env.owner, `mp:ok:${code}`)), /Đã xác nhận/);
  const b = getBooking(1);
  assert.equal(b.status, "CONFIRMED");
  assert.match(dms(env.client, IDS.cust).at(-1), /Đã nhận thanh toán\. Lịch #1/);
  assert.match(dms(env.client, IDS.player).at(-1), /Bạn có lịch mới/);
  assert.equal(getOrder(code).status, "PAID");
  assert.match(textOf(await env.click(env.owner, `mp:ok:${code}`)), /đã được xác nhận rồi/);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'CONFIRMED'").get().n, 1);
});

test("a confirmation that comes after the booking expired is refunded as a late payment", async () => {
  receive();
  await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  const code = getDb().prepare("SELECT order_code FROM orders").get().order_code;
  const { runSchedule } = await import("../src/jobs/schedule.js");
  await runSchedule(env.client, { now: NOW + 40 * MIN });
  assert.equal(getBooking(1).status, "EXPIRED");
  await tick(NOW + 41 * MIN);
  assert.equal(getOrder(code).status, "EXPIRED", "the order timed out with the booking");
  setClock(() => NOW + 45 * MIN);
  const answer = await env.click(env.owner, `mp:ok:${code}`);
  assert.match(textOf(answer), /đã hết hạn nên khoản này được ghi nợ hoàn lại/);
  const refund = ledgerRows(1).find((r) => r.kind === "REFUND");
  assert.equal(refund.amount_vnd, 100_000);
  assert.equal(refund.status, "OWED");
  assert.match(dms(env.client, IDS.cust).at(-1), /đến sau khi lịch đã hết hạn/);
});

test("the customer's 'I have transferred' button asks the owner to check, once the order is theirs", async () => {
  receive();
  await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  const code = getDb().prepare("SELECT order_code FROM orders").get().order_code;
  assert.match(textOf(await env.click(IDS.rando, `mp:told:${code}`)), /Bạn cần xác nhận|không có quyền/);
  assert.match(textOf(await env.click(IDS.cust, `mp:told:${code}`)), /Đã báo cho chủ server/);
  const told = owed().find((m) => /Khách báo đã chuyển/.test(JSON.stringify(m.embeds ?? [])));
  assert.ok(told, "the owner got a notice that says the customer has transferred");
  assert.deepEqual(buttonIds({ components: told.components }), [`mp:ok:${code}`]);
  assert.equal(getBooking(1).status, "AWAITING_PAYMENT");
});

test("a wallet top-up by transfer credits the wallet only after the owner confirms", async () => {
  receive();
  const { settings } = { settings: (await import("../src/settings.js")).getSettings() };
  const pack = settings.packages[0];
  const answer = await env.click(IDS.cust, `wl:topup:${pack.amountVnd}`);
  assert.match(textOf(answer), /nội dung: NAP\d{5}/);
  assert.equal(walletBalance(IDS.cust), 0);
  const code = getDb().prepare("SELECT order_code FROM orders WHERE kind = 'TOPUP'").get().order_code;
  await tick(NOW + MIN);
  await env.click(env.owner, `mp:ok:${code}`);
  const bonus = Math.floor((pack.amountVnd * pack.bonusPercent) / 100);
  assert.equal(walletBalance(IDS.cust), pack.amountVnd + bonus);
});

test("/admin cho-xac-nhan lists transfers waiting for the owner, and only for the owner", async () => {
  receive();
  assert.match(textOf(await env.command(env.owner, "admin", { subcommand: "cho-xac-nhan" })), /Không có khoản chuyển khoản nào/);
  await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  assert.match(textOf(await env.command(IDS.cust, "admin", { subcommand: "cho-xac-nhan" })), /không có quyền/);
  const listed = await env.command(env.owner, "admin", { subcommand: "cho-xac-nhan" });
  assert.match(JSON.stringify(lastPayload(listed).embeds), /Chờ chuyển khoản/);
  assert.match(buttonIds(lastPayload(listed))[0], /^mp:ok:\d+$/);
});

test("details for a page: bank, amount, note and a QR image, and nothing for an order that is not a transfer", async () => {
  receive();
  await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  const code = getDb().prepare("SELECT order_code FROM orders").get().order_code;
  const d = manualDetails(code);
  assert.equal(d.bankName, "MB Bank");
  assert.equal(d.amountVnd, 100_000);
  assert.match(d.note, /^BOOK\d{5}$/);
  assert.match(d.qrUrl, /^https:\/\/img\.vietqr\.io\//);
  assert.equal(manualDetails(123), null);
  assert.equal(manualDetails(undefined), null);
});
