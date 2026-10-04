import { NOW, HOUR, MIN, makePlayer, makeCustomer, confirmed, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { textOf, modalOf, lastPayload, buttonIds } from "./discord-fakes.js";
import { complete, SYSTEM, openDispute, resolveDispute, actorFor } from "../src/domain/bookings.js";
import { addNote, listNotes, deleteNote, customerProfile, disputeFlag, addReport, reporterHash } from "../src/domain/people.js";
import { setClock } from "../src/discord/clock.js";
import { refreshCard } from "../src/discord/cards.js";

let env;
beforeEach(async () => {
  env = await boot();
  makePlayer(IDS.player);
  makeCustomer(IDS.cust);
  makeCustomer(IDS.cust2);
  env.guild.addMember({ id: IDS.player });
  env.guild.addMember({ id: IDS.cust });
  await refreshCard(env.guild, IDS.player);
});

function finished(customerId = IDS.cust, startAt = NOW + 3 * HOUR) {
  const b = confirmed({ customerId, playerId: IDS.player, startAt });
  getDb().prepare("UPDATE bookings SET status = 'IN_PROGRESS', started_at = ? WHERE id = ?").run(startAt, b.id);
  complete(b.id, SYSTEM, startAt + HOUR);
  return b;
}

// ---------------------------------------------------------------- notes and the staff card

test("internal notes are cleaned, listed newest first and can be removed", () => {
  const id = addNote("u1", "hay đến muộn @everyone http://x.example", "staff1", NOW);
  addNote("u1", "đã nhắc nhở", "staff1", NOW + 1);
  const notes = listNotes("u1");
  assert.equal(notes[0].note, "đã nhắc nhở");
  assert.ok(!notes[1].note.includes("everyone") && !notes[1].note.includes("x.example"));
  assert.throws(() => addNote("u1", "   ", "s"), /không được để trống/);
  assert.equal(deleteNote(id), true);
  assert.equal(deleteNote(id), false);
  assert.equal(listNotes("u1").length, 1);
});

test("/staff ghi-chu, xem-khach and xoa-ghi-chu are for staff only and show the facts", async () => {
  finished();
  const denied = await env.command(IDS.cust, "staff", { subcommand: "xem-khach", opts: { user: { id: IDS.cust } } });
  assert.match(textOf(denied), /không có quyền/);
  await env.command(IDS.staff, "staff", { subcommand: "ghi-chu", opts: { user: { id: IDS.cust }, "noi-dung": "khách quen, dễ tính" } });
  const shown = await env.command(IDS.staff, "staff", { subcommand: "xem-khach", opts: { user: { id: IDS.cust } } });
  const text = textOf(shown);
  assert.match(text, /1 lịch \(Hoàn thành: 1\)/);
  assert.match(text, /Đã chi: 100\.000 đ/);
  assert.match(text, /khách quen, dễ tính/);
  assert.match(text, /Danh sách cấm: Không/);
  const noteId = listNotes(IDS.cust)[0].id;
  assert.match(textOf(await env.command(IDS.staff, "staff", { subcommand: "xoa-ghi-chu", opts: { id: noteId } })), /Đã xoá ghi chú/);
  assert.equal(customerProfile(IDS.cust).notes.length, 0);
});

// ---------------------------------------------------------------- disputes that keep being lost

function lostDispute(startAt) {
  const b = finished(IDS.cust, startAt);
  const { dispute } = openDispute(b.id, actorFor(b, IDS.cust), "không hài lòng", startAt + 2 * HOUR);
  resolveDispute(dispute.id, "pay_player", "staff1", "", startAt + 3 * HOUR);
  return b;
}

test("a customer who opens many disputes and loses them is flagged, and only inside the window", () => {
  lostDispute(NOW + 3 * HOUR);
  lostDispute(NOW + 6 * HOUR);
  assert.equal(disputeFlag(IDS.cust, NOW + 10 * HOUR).flagged, false);
  lostDispute(NOW + 9 * HOUR);
  const flag = disputeFlag(IDS.cust, NOW + 12 * HOUR);
  assert.equal(flag.flagged, true);
  assert.equal(flag.opened, 3);
  assert.equal(flag.rejected, 3);
  assert.equal(disputeFlag(IDS.cust, NOW + 90 * 24 * HOUR).flagged, false, "old disputes fall out of the window");
  assert.equal(disputeFlag(IDS.cust2, NOW).opened, 0);
});

test("opening the third dispute warns staff in the disputes channel", async () => {
  lostDispute(NOW + 3 * HOUR);
  lostDispute(NOW + 6 * HOUR);
  const b = finished(IDS.cust, NOW + 9 * HOUR);
  setClock(() => NOW + 10 * HOUR);
  await env.submit(IDS.cust, `bk:problem:submit:${b.id}`, { reason: "lại có chuyện" });
  const posts = env.channel("disputesChannelId").sent;
  assert.ok(posts.some((m) => /Cần xem xét: <@.*> đã mở 3 khiếu nại/.test(m.content ?? "")));
});

// ---------------------------------------------------------------- anonymous reports

test("a report never stores or shows who wrote it, and the writer is limited to five a day", async () => {
  const form = await env.command(IDS.cust, "baocao", { opts: { nguoi: { id: IDS.player, bot: false } } });
  assert.equal(modalOf(form).toJSON().custom_id, `rp:new:${IDS.player}`);
  const sent = await env.submit(IDS.cust, `rp:new:${IDS.player}`, { text: "Player này nói chuyện không phù hợp" });
  assert.match(textOf(sent), /họ không biết bạn là ai|không biết bạn là ai/);
  const posted = env.channel("disputesChannelId").sent.at(-1);
  const json = JSON.stringify(posted.embeds);
  assert.match(json, /Báo cáo ẩn danh #1/);
  assert.match(json, new RegExp(IDS.player));
  assert.ok(!json.includes(IDS.cust), "the reporter is not named");
  const row = getDb().prepare("SELECT * FROM reports").get();
  assert.ok(!JSON.stringify(row).includes(IDS.cust));
  assert.equal(row.reporter_hash, reporterHash(IDS.cust));
  assert.notEqual(reporterHash(IDS.cust), reporterHash(IDS.cust2));

  for (let i = 0; i < 4; i += 1) addReport({ reporterId: IDS.cust, text: "báo cáo thêm số " + i + " xxxxxx" }, NOW + i);
  assert.throws(() => addReport({ reporterId: IDS.cust, text: "báo cáo thứ sáu xxxx" }, NOW + 10), /nhiều báo cáo hôm nay/);
  assert.equal(addReport({ reporterId: IDS.cust, text: "đã qua một ngày rồi xx" }, NOW + 25 * HOUR).id, 6);
  assert.throws(() => addReport({ reporterId: IDS.cust2, aboutUserId: IDS.cust2, text: "tự báo cáo mình xxxxx" }), /chính mình/);
  assert.throws(() => addReport({ reporterId: IDS.cust2, text: "ngắn" }), /rõ hơn/);
});

test("only staff can mark a report handled; strangers need the 18+ confirmation to report at all", async () => {
  await env.submit(IDS.cust, "rp:new:0", { text: "có người làm phiền trong phòng" });
  const post = env.channel("disputesChannelId").sent.at(-1);
  assert.deepEqual(buttonIds({ components: post.components }), ["rp:done:1"]);
  assert.match(textOf(await env.click(IDS.cust, "rp:done:1")), /không có quyền/);
  assert.match(textOf(await env.click(IDS.staff, "rp:done:1", post)), /Đã đánh dấu báo cáo #1/);
  assert.ok(getDb().prepare("SELECT handled_at FROM reports WHERE id = 1").get().handled_at);
  assert.match(textOf(await env.submit(IDS.rando, "rp:new:0", { text: "báo cáo từ người lạ xxxx" })), /18 tuổi/);
});

// ---------------------------------------------------------------- booking again

test("the rating thank-you offers the same player again, and the button opens the booking form for that player and game", async () => {
  const b = finished();
  setClock(() => NOW + 4 * HOUR + MIN);
  const thanks = await env.submit(IDS.cust, `bk:rate:submit:${b.id}:5`, { review: "" });
  assert.deepEqual(buttonIds(lastPayload(thanks)), [10_000, 20_000, 50_000, 100_000].map((a) => `bk:tip:${b.id}:${a}`).concat(`bk:again:${b.id}`));
  const open = await env.click(IDS.cust, `bk:again:${b.id}`);
  const json = modalOf(open).toJSON();
  assert.equal(json.custom_id, `bk:new:${IDS.player}`);
  assert.equal(json.components[0].components[0].value, "Liên Quân");
  assert.match(textOf(await env.click(IDS.cust2, `bk:again:${b.id}`)), /không có quyền/);
});

test("a person cannot be reported or booked again when the player is not accepting bookings", async () => {
  const b = finished();
  getDb().prepare("UPDATE players SET status = 'PAUSED' WHERE user_id = ?").run(IDS.player);
  setClock(() => NOW + 4 * HOUR + MIN);
  const list = await env.command(IDS.cust, "lichcuatoi");
  assert.ok(!buttonIds(lastPayload(list)).includes(`bk:again:${b.id}`));
  assert.match(textOf(await env.click(IDS.cust, `bk:again:${b.id}`)), /không nhận lịch/);
});
