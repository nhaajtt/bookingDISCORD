import { NOW, HOUR, makePlayer, makeCustomer, confirmed, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { textOf, modalOf, lastPayload } from "./discord-fakes.js";
import { cancel } from "../src/domain/bookings.js";
import { findBank, getBank, setBank, vietQrUrl, transferNote, bankLine } from "../src/domain/bank.js";
import { bookingsCsv, ledgerCsv } from "../src/domain/export.js";
import { setClock } from "../src/discord/clock.js";

let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
});

test("bank names, aliases and BIN codes are recognised", () => {
  assert.deepEqual(findBank("Vietcombank"), { name: "Vietcombank", bin: "970436" });
  assert.deepEqual(findBank("vcb"), { name: "Vietcombank", bin: "970436" });
  assert.deepEqual(findBank("MB"), { name: "MB Bank", bin: "970422" });
  assert.deepEqual(findBank("Đông Á"), { name: "DongA Bank", bin: "970406" });
  assert.deepEqual(findBank("970407"), { name: "Techcombank", bin: "970407" });
  assert.deepEqual(findBank("123456"), { name: "Ngân hàng 123456", bin: "123456" });
  assert.equal(findBank("ngân hàng không có"), null);
  assert.equal(findBank(""), null);
});

test("setBank validates and normalizes, and a second call replaces the first", () => {
  const row = setBank("u1", { bank: "vcb", accountNo: "0123 456-789", accountName: "Nguyễn Văn Á" }, NOW);
  assert.equal(row.account_no, "0123456789");
  assert.equal(row.account_name, "NGUYEN VAN A");
  assert.equal(row.bank_bin, "970436");
  setBank("u1", { bank: "acb", accountNo: "999999", accountName: "B" + "C" }, NOW + 1);
  assert.equal(getBank("u1").bank_name, "ACB");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM bank_accounts").get().n, 1);
  assert.throws(() => setBank("u1", { bank: "nope", accountNo: "123456", accountName: "AB" }), /Không nhận ra ngân hàng/);
  assert.throws(() => setBank("u1", { bank: "acb", accountNo: "12ab", accountName: "AB" }), /Số tài khoản/);
  assert.throws(() => setBank("u1", { bank: "acb", accountNo: "123456", accountName: "" }), /tên chủ tài khoản/);
});

test("the VietQR link carries bank, account, amount and a plain transfer note", () => {
  const bank = setBank("u1", { bank: "mb", accountNo: "0987654321", accountName: "Tran Thi B" }, NOW);
  const url = vietQrUrl(bank, 90_000, transferNote({ kind: "PLAYER_PAYOUT", booking_id: 12 }));
  assert.match(url, /^https:\/\/img\.vietqr\.io\/image\/970422-0987654321-compact2\.png\?/);
  const q = new URL(url).searchParams;
  assert.equal(q.get("amount"), "90000");
  assert.equal(q.get("addInfo"), "TRA LICH 12");
  assert.equal(q.get("accountName"), "TRAN THI B");
  assert.equal(transferNote({ kind: "REFUND", booking_id: 3 }), "HOAN LICH 3");
  assert.equal(bankLine(null), "chưa có tài khoản");
});

test("/nganhang opens the form, saves it, shows it and removes it; strangers without the 18+ confirmation are refused", async () => {
  const form = await env.command(IDS.player, "nganhang", { subcommand: "cap-nhat" });
  assert.ok(modalOf(form));
  const saved = await env.submit(IDS.player, "bank:set", { bank: "Techcombank", number: "19031234567890", holder: "Le Van C" });
  assert.match(textOf(saved), /Techcombank 19031234567890 LE VAN C/);
  const shown = await env.command(IDS.player, "nganhang", { subcommand: "xem" });
  assert.match(textOf(shown), /LE VAN C/);
  const bad = await env.submit(IDS.player, "bank:set", { bank: "zzz", number: "123456", holder: "AB" });
  assert.match(textOf(bad), /Không nhận ra ngân hàng/);
  const removed = await env.command(IDS.player, "nganhang", { subcommand: "xoa" });
  assert.match(textOf(removed), /Đã xoá/);
  assert.equal(getBank(IDS.player), null);
  const stranger = await env.command(IDS.rando, "nganhang", { subcommand: "xem" });
  assert.match(textOf(stranger), /18 tuổi/);
});

function refundSetup() {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 9 * HOUR });
  cancel(b.id, { role: "player", userId: IDS.player }, NOW);
  return b;
}

test("the money queue shows the bank of the person owed, and the QR mode builds one image per row", async () => {
  const b = refundSetup();
  setBank(IDS.cust, { bank: "acb", accountNo: "123456789", accountName: "Khach Hang" }, NOW);
  const queue = await env.command(IDS.owner, "chuyentien");
  assert.match(textOf(queue), /ACB 123456789 KHACH HANG/);
  const qr = await env.command(IDS.owner, "chuyentien", { opts: { "che-do": "qr" } });
  const embed = lastPayload(qr).embeds[0].toJSON();
  assert.match(embed.image.url, /970416-123456789/);
  assert.match(embed.description, new RegExp(`HOAN LICH ${b.id}`));
  const none = await env.command(IDS.staff, "chuyentien", { opts: { "che-do": "qr" } });
  assert.match(textOf(none), /không có quyền/);
});

test("the QR mode tells the owner when nobody saved a bank yet", async () => {
  refundSetup();
  const qr = await env.command(IDS.owner, "chuyentien", { opts: { "che-do": "qr" } });
  assert.match(textOf(qr), /Chưa có tài khoản, nhắc họ dùng \/nganhang/);
});

test("CSV export lists the rows with bank details and never lets a cell run as a formula", async () => {
  const b = refundSetup();
  setBank(IDS.cust, { bank: "vcb", accountNo: "111222333", accountName: "Khach Hang" }, NOW);
  const text = ledgerCsv({ status: "OWED" });
  assert.ok(text.startsWith("﻿id,booking,loai"));
  const line = text.split("\r\n")[1];
  assert.match(line, new RegExp(`^\\d+,${b.id},hoan_tien,${IDS.cust},100000,can_chuyen,Vietcombank,111222333,KHACH HANG,HOAN LICH ${b.id},`));
  getDb().prepare("UPDATE ledger SET note = ? WHERE booking_id = ?").run('=HYPERLINK("x")', b.id);
  assert.match(ledgerCsv(), /'=HYPERLINK\(""x""\)/);
  assert.equal(ledgerCsv({ status: "PAID" }).trim().split("\r\n").length, 1, "header only");
  assert.match(bookingsCsv(), new RegExp(`^\\uFEFFid,khach,player.*\\r\\n${b.id},`, "s"));

  setClock(() => NOW);
  const file = await env.command(IDS.owner, "chuyentien", { opts: { "che-do": "csv" } });
  const attachment = lastPayload(file).files[0];
  assert.equal(attachment.name, "can-chuyen.csv");
  for (const mode of ["csv-tat-ca", "csv-lich"]) assert.ok(lastPayload(await env.command(IDS.owner, "chuyentien", { opts: { "che-do": mode } })).files.length);
});
