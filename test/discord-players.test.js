import { NOW, getDb } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, modalOf, buttonIds } from "./discord-fakes.js";
import { attest, hasAttested } from "../src/domain/attestations.js";
import { getPlayer, applyAsPlayer } from "../src/domain/players.js";
import { getAvailability } from "../src/domain/availability.js";
import { addToBlacklist } from "../src/domain/strikes.js";

let env;
beforeEach(async () => {
  env = await boot();
});

const modalFields = (i) => modalOf(i).toJSON().components.map((row) => row.components[0]);
const hasRole = (userId, key) => env.guild.members.cache.get(userId).roles.cache.has(env.role(key));

// ---------------------------------------------------------------- age gate

test("the age gate: a wrong phrase is refused, the right one (any case, no accents) attests and grants the role", async () => {
  const open = await env.click(IDS.cust, "age:open");
  const modal = modalOf(open);
  assert.equal(modal.toJSON().custom_id, "age:submit");
  assert.equal(modal.toJSON().components.length, 1);

  const wrong = await env.submit(IDS.cust, "age:submit", { phrase: "tôi 17 tuổi" });
  assert.match(textOf(wrong), /Câu xác nhận chưa đúng. Hãy gõ: TÔI ĐÃ ĐỦ 18 TUỔI/);
  assert.equal(hasAttested(IDS.cust), false);
  assert.equal(hasRole(IDS.cust, "verifiedRoleId"), false);

  const right = await env.submit(IDS.cust, "age:submit", { phrase: "toi da du 18 tuoi" });
  assert.match(textOf(right), /Đã xác nhận\. Bạn có thể xem các kênh đặt lịch/);
  assert.match(textOf(right), /nội dung lành mạnh/);
  assert.equal(hasAttested(IDS.cust), true);
  assert.equal(hasRole(IDS.cust, "verifiedRoleId"), true);
  assert.ok(right.out.some((o) => o.type === "defer" && o.payload.flags), "the answer is private");
});

test("a second click after attesting grants a role that was removed by hand and keeps the first timestamp", async () => {
  attest(IDS.cust, NOW - 1000);
  const again = await env.click(IDS.cust, "age:open");
  assert.equal(modalOf(again), undefined);
  assert.match(textOf(again), /Bạn đã xác nhận rồi/);
  assert.equal(hasRole(IDS.cust, "verifiedRoleId"), true);
  assert.equal(getDb().prepare("SELECT at FROM attestations WHERE user_id = ?").get(IDS.cust).at, NOW - 1000);
});

test("a blacklisted person cannot pass the gate, and guessing is rate limited", async () => {
  addToBlacklist(IDS.rando, "spam", IDS.owner, NOW);
  const open = await env.click(IDS.rando, "age:open");
  assert.match(textOf(open), /không được phép/);
  const submit = await env.submit(IDS.rando, "age:submit", { phrase: "TÔI ĐÃ ĐỦ 18 TUỔI" });
  assert.match(textOf(submit), /không được phép/);
  assert.equal(hasAttested(IDS.rando), false);

  let last;
  for (let n = 0; n < 9; n += 1) last = await env.submit(IDS.cust2, "age:submit", { phrase: "sai" });
  assert.match(textOf(last), /quá nhiều/);
});

test("if the verified role cannot be granted the attestation is still recorded", async () => {
  env.guild.addMember({ id: IDS.cust }).failRoleChange = true;
  const original = console.error;
  console.error = () => {};
  try {
    const right = await env.submit(IDS.cust, "age:submit", { phrase: "TÔI ĐÃ ĐỦ 18 TUỔI" });
    assert.match(textOf(right), /Đã xác nhận/);
    assert.equal(hasAttested(IDS.cust), true);
  } finally {
    console.error = original;
  }
});

// ---------------------------------------------------------------- applying

const application = { name: "Mai @everyone", games: "Liên Quân, LoL, Trò chuyện", rate: "100k", bio: "Xin chào https://evil.example <@&123> mình là Mai", languages: "Tiếng Việt" };

test("applying needs the 18+ confirmation first", async () => {
  const click = await env.click(IDS.player, "pl:apply");
  assert.equal(modalOf(click), undefined);
  assert.match(textOf(click), /xác nhận mình đủ 18 tuổi/);
  const submit = await env.submit(IDS.player, "pl:apply:submit", application);
  assert.match(textOf(submit), /xác nhận mình đủ 18 tuổi/);
  assert.equal(getPlayer(IDS.player), null);
});

test("an application is cleaned, stored as PENDING and posted to staff with approve and reject buttons", async () => {
  attest(IDS.player, NOW);
  const click = await env.click(IDS.player, "pl:apply");
  assert.deepEqual(modalFields(click).map((f) => f.custom_id), ["name", "games", "rate", "bio", "languages"]);

  const sent = await env.submit(IDS.player, "pl:apply:submit", application);
  assert.match(textOf(sent), /Đã nhận hồ sơ của bạn/);
  const p = getPlayer(IDS.player);
  assert.equal(p.status, "PENDING");
  assert.equal(p.rateVnd, 100_000);
  assert.deepEqual(p.games, ["Liên Quân", "LoL", "Trò chuyện"]);
  assert.ok(!p.displayName.includes("@"));
  assert.ok(!/evil|<@/.test(p.bio));

  const queue = env.channel("applicationsChannelId").sent;
  assert.equal(queue.length, 1);
  assert.deepEqual(buttonIds({ components: queue[0].components }), [`pl:approve:${IDS.player}`, `pl:reject:${IDS.player}`]);
  const shown = JSON.stringify(queue[0].embeds);
  assert.ok(!shown.includes("everyone") && !shown.includes("evil"));
  assert.deepEqual(queue[0].allowedMentions, { parse: [] });
});

test("bad rates and out of range rates are answered in Vietnamese and nothing is stored", async () => {
  attest(IDS.player, NOW);
  assert.match(textOf(await env.submit(IDS.player, "pl:apply:submit", { ...application, rate: "rẻ thôi" })), /Giá theo giờ chưa đúng/);
  assert.match(textOf(await env.submit(IDS.player, "pl:apply:submit", { ...application, rate: "5000" })), /Giá theo giờ phải từ/);
  assert.match(textOf(await env.submit(IDS.player, "pl:apply:submit", { ...application, games: " , " })), /ít nhất một game/);
  assert.equal(getPlayer(IDS.player), null);
  assert.equal(env.channel("applicationsChannelId").sent.length, 0);
});

test("applications are rate limited", async () => {
  attest(IDS.player, NOW);
  let last;
  for (let n = 0; n < 5; n += 1) last = await env.submit(IDS.player, "pl:apply:submit", application);
  assert.match(textOf(last), /gửi hồ sơ quá nhiều lần/);
});

// ---------------------------------------------------------------- staff decision

async function applied() {
  attest(IDS.player, NOW);
  await env.submit(IDS.player, "pl:apply:submit", application);
  return env.channel("applicationsChannelId").sent[0];
}

test("approve: staff only, role granted, card posted and remembered, player told, queue message closed", async () => {
  const queue = await applied();
  const forged = await env.click(IDS.rando, `pl:approve:${IDS.player}`, queue);
  assert.match(textOf(forged), /không có quyền/);
  assert.equal(getPlayer(IDS.player).status, "PENDING");
  const playerAsStaff = await env.click(IDS.player, `pl:approve:${IDS.player}`, queue);
  assert.match(textOf(playerAsStaff), /không có quyền/);

  const ok = await env.click(IDS.staff, `pl:approve:${IDS.player}`, queue);
  assert.match(textOf(ok), /Đã duyệt/);
  const p = getPlayer(IDS.player);
  assert.equal(p.status, "ACTIVE");
  assert.equal(hasRole(IDS.player, "playerRoleId"), true);

  const card = env.channel("playersChannelId").sent;
  assert.equal(card.length, 1);
  assert.equal(p.profileMessageId, card[0].id);
  assert.match(card[0].embeds[0].title, /Mai/);
  assert.ok(card[0].embeds[0].fields.some((f) => /100\.000/.test(f.value)));
  const book = card[0].components[0].components[0];
  assert.equal(book.custom_id, `pl:book:${IDS.player}`);
  assert.equal(book.disabled, true, "no availability yet, so the button is off");
  assert.match(card[0].embeds[0].footer.text, /Chưa có lịch rảnh/);

  assert.match(dms(env.client, IDS.player).join(" "), /đã được duyệt.*\/lichranh/);
  assert.deepEqual(queue.components, []);
  assert.match(queue.embeds[0].footer.text, /Đã duyệt bởi/);

  const again = await env.click(IDS.staff, `pl:approve:${IDS.player}`, queue);
  assert.match(textOf(again), /đã được xử lý/);
  assert.equal(env.channel("playersChannelId").sent.length, 1, "no second card");
  assert.match(env.channel("bookingsLogChannelId").sent.at(-1).content, /đã duyệt player/);
});

test("reject: staff only, asks for a reason, tells the player, and the player may apply again", async () => {
  const queue = await applied();
  assert.match(textOf(await env.click(IDS.rando, `pl:reject:${IDS.player}`, queue)), /không có quyền/);
  const open = await env.click(IDS.staff, `pl:reject:${IDS.player}`, queue);
  assert.equal(modalOf(open).toJSON().custom_id, `pl:reject:submit:${IDS.player}`);

  assert.match(textOf(await env.submit(IDS.rando, `pl:reject:submit:${IDS.player}`, { reason: "x" }, queue)), /không có quyền/);
  assert.equal(getPlayer(IDS.player).status, "PENDING");

  const done = await env.submit(IDS.staff, `pl:reject:submit:${IDS.player}`, { reason: "Giới thiệu quá ngắn @everyone" }, queue);
  assert.match(textOf(done), /Đã từ chối/);
  assert.equal(getPlayer(IDS.player).status, "REJECTED");
  const told = dms(env.client, IDS.player).join(" ");
  assert.match(told, /Giới thiệu quá ngắn/);
  assert.ok(!told.includes("@"));
  assert.match(queue.embeds[0].footer.text, /Đã từ chối bởi/);

  await env.submit(IDS.player, "pl:apply:submit", application);
  assert.equal(getPlayer(IDS.player).status, "PENDING");
});

// ---------------------------------------------------------------- availability, pause, profile, earnings

async function activePlayer() {
  const queue = await applied();
  await env.click(IDS.staff, `pl:approve:${IDS.player}`, queue);
}

test("/lichranh: parse errors are listed in Vietnamese with an example, a good schedule is saved and the card turns on", async () => {
  await activePlayer();
  const bad = await env.command(IDS.player, "lichranh", { opts: { lich: "T9 19:00-23:00; T2 25:00-26:00" } });
  const text = textOf(bad);
  assert.match(text, /Chưa lưu được lịch rảnh/);
  assert.match(text, /Không hiểu ngày/);
  assert.match(text, /Ví dụ: T2 19:00-23:00/);
  assert.equal(getAvailability(IDS.player).length, 0);

  const good = await env.command(IDS.player, "lichranh", { opts: { lich: "T2 19:00-23:00; CN 09:00-12:00" } });
  assert.match(textOf(good), /Đã lưu lịch rảnh: T2 19:00-23:00; CN 09:00-12:00\. Giờ tính theo múi giờ Asia\/Ho_Chi_Minh\./);
  assert.equal(getAvailability(IDS.player).length, 2);
  const card = env.channel("playersChannelId").sent[0];
  assert.equal(card.components[0].components[0].disabled, false);
  assert.equal(card.edits.length, 1, "the card is edited in place");
  assert.ok(card.embeds[0].fields.some((f) => f.name === "Lịch rảnh" && /T2 19:00-23:00/.test(f.value)));
});

test("/lichranh without text opens a form prefilled with the current schedule, and the form saves or explains", async () => {
  await activePlayer();
  await env.command(IDS.player, "lichranh", { opts: { lich: "T3 20:00-22:00" } });
  const form = await env.command(IDS.player, "lichranh");
  assert.equal(modalFields(form)[0].value, "T3 20:00-22:00");
  const saved = await env.submit(IDS.player, "pl:avail:submit", { text: "T4 18:00-20:00" });
  assert.match(textOf(saved), /Đã lưu lịch rảnh: T4 18:00-20:00/);
  const bad = await env.submit(IDS.player, "pl:avail:submit", { text: "tối thứ hai" });
  assert.match(textOf(bad), /Không hiểu ngày/);
  assert.deepEqual(getAvailability(IDS.player).map((s) => s.weekday), [3], "a rejected text keeps the old schedule");
});

test("/lichranh, /thunhap and /player are for players only", async () => {
  attest(IDS.cust, NOW);
  for (const [name, opts] of [["lichranh", { lich: "T2 19:00-20:00" }], ["thunhap", {}]]) {
    const i = await env.command(IDS.cust, name, { opts });
    assert.match(textOf(i), /Chỉ player đã được duyệt/, name);
  }
  assert.match(textOf(await env.command(IDS.cust, "player", { subcommand: "tam-nghi" })), /Chỉ player đã được duyệt/);
  assert.match(textOf(await env.command(IDS.rando, "thunhap")), /xác nhận mình đủ 18 tuổi/);
});

test("pause turns the card off and resume turns it back on", async () => {
  await activePlayer();
  await env.command(IDS.player, "lichranh", { opts: { lich: "T2 19:00-23:00" } });
  const card = env.channel("playersChannelId").sent[0];
  const paused = await env.command(IDS.player, "player", { subcommand: "tam-nghi" });
  assert.match(textOf(paused), /Đã chuyển sang trạng thái nghỉ/);
  assert.equal(getPlayer(IDS.player).status, "PAUSED");
  assert.equal(card.components[0].components[0].disabled, true);
  assert.match(card.embeds[0].footer.text, /Đang nghỉ/);
  const back = await env.command(IDS.player, "player", { subcommand: "nhan-lai" });
  assert.match(textOf(back), /Bạn đã nhận lịch trở lại/);
  assert.equal(card.components[0].components[0].disabled, false);
});

test("/player thong-tin opens a form with the current profile and updates the card", async () => {
  await activePlayer();
  const form = await env.command(IDS.player, "player", { subcommand: "thong-tin" });
  assert.equal(modalOf(form).toJSON().custom_id, "pl:profile:submit");
  assert.equal(modalFields(form)[2].value, "100000");
  const saved = await env.submit(IDS.player, "pl:profile:submit", { name: "Mai Linh", games: "LoL", rate: "150.000", bio: "Mới", languages: "vi" });
  assert.match(textOf(saved), /Đã cập nhật hồ sơ/);
  assert.equal(getPlayer(IDS.player).rateVnd, 150_000);
  assert.match(env.channel("playersChannelId").sent[0].embeds[0].title, /Mai Linh/);
  assert.match(textOf(await env.submit(IDS.player, "pl:profile:submit", { name: "x", games: "LoL", rate: "abc", bio: "", languages: "" })), /Giá theo giờ chưa đúng/);
});

test("/thunhap answers privately with the earnings in the agreed wording", async () => {
  await activePlayer();
  const i = await env.command(IDS.player, "thunhap");
  const text = textOf(i);
  assert.match(text, /Đã hoàn thành: 0 buổi\./);
  assert.match(text, /Đánh giá: chưa có\./);
  assert.match(text, /Chờ chuyển: 0 đ \(đang giữ đến hết thời gian khiếu nại: 0 đ\)\./);
  assert.match(text, /Đã nhận: 0 đ\./);
  assert.match(text, /Buổi tới: 0\./);
  assert.ok(i.out[0].type === "defer" && i.out[0].payload.flags);
});

test("a player who is not on the server any more can still be approved without the role call failing the decision", async () => {
  attest(IDS.player2, NOW);
  applyAsPlayer({ userId: IDS.player2, displayName: "Vắng", games: ["LoL"], rateVnd: 50_000, bio: "", languages: "" }, NOW);
  const original = console.error;
  console.error = () => {};
  try {
    const ok = await env.click(IDS.staff, `pl:approve:${IDS.player2}`);
    assert.equal(getPlayer(IDS.player2).status, "ACTIVE");
    assert.match(textOf(ok), /Chưa cấp được role Người chơi/);
  } finally {
    console.error = original;
  }
});
