import { NOW, HOUR, MIN, DAY, makePlayer, makeCustomer, confirmed, book, getDb, getSettings, saveSettings } from "./helpers.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { boot, IDS } from "./discord-env.js";
import { dms, textOf, modalOf, buttonIds, lastPayload } from "./discord-fakes.js";
import { refreshCard } from "../src/discord/cards.js";
import { setClock } from "../src/discord/clock.js";
import { runSchedule } from "../src/jobs/schedule.js";
import { runWaitlist } from "../src/jobs/waitlist.js";
import { runSeries } from "../src/jobs/series.js";
import { checkPayments } from "../src/jobs/payments.js";
import { translate, langFor, setLang, getPref, translatePayload, LANGS } from "../src/i18n.js";
import { DomainError } from "../src/domain/errors.js";
import { CATALOG } from "../src/i18n/en.js";
import { creditTopup, payFromWallet } from "../src/domain/wallet.js";
import { cancel, actorFor, getBooking, start, complete, SYSTEM } from "../src/domain/bookings.js";
import { joinWaitlist } from "../src/domain/waitlist.js";
import { createSeries } from "../src/domain/series.js";
import { sendDm } from "../src/discord/guild.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";

const VIETNAMESE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

// Every piece of text a person could read in an answer: content, embeds, button and menu labels, form titles and fields
function textsOf(payload) {
  const out = [];
  if (!payload) return out;
  if (typeof payload === "string") return [payload];
  if (payload.content) out.push(payload.content);
  for (const e of payload.embeds ?? []) {
    const j = typeof e.toJSON === "function" ? e.toJSON() : e;
    out.push(j.title, j.description, j.footer?.text, ...(j.fields ?? []).flatMap((f) => [f.name, f.value]));
  }
  for (const row of payload.components ?? []) {
    const j = typeof row.toJSON === "function" ? row.toJSON() : row;
    for (const c of j.components ?? []) out.push(c.label, c.placeholder, ...(c.options ?? []).flatMap((o) => [o.label, o.description]));
  }
  return out.filter((t) => typeof t === "string" && t.length);
}
function modalTexts(modal) {
  const j = modal.toJSON();
  return [j.title, ...j.components.flatMap((r) => r.components.flatMap((c) => [c.label, c.placeholder]))].filter(Boolean);
}
function allTexts(interaction) {
  const out = [];
  for (const o of interaction.out) {
    if (o.modal) out.push(...modalTexts(o.modal));
    else out.push(...textsOf(o.payload));
  }
  return out;
}
const dmTexts = (client, userId) => client.dmLog.filter((d) => d.userId === userId).flatMap((d) => textsOf(d.payload));

const leaks = [];
const check = (label, texts) => {
  for (const t of texts) if (VIETNAMESE.test(t)) leaks.push(`${label}: ${t}`);
};

let env;
beforeEach(async () => {
  env = await boot();
  leaks.length = 0;
  makePlayer(IDS.player, { rateVnd: 100_000, games: ["LoL", "Chatting"] });
  makeCustomer(IDS.cust);
  makeCustomer(IDS.cust2);
  for (const id of [IDS.player, IDS.cust, IDS.cust2]) env.guild.addMember({ id });
  await refreshCard(env.guild, IDS.player);
  setLang(IDS.cust, "en");
  setLang(IDS.cust2, "en");
  setLang(IDS.player, "en");
});
afterEach(() => {
  globalThis.fetch = undefined;
  setClock(() => NOW);
});
const done = () => assert.deepEqual(leaks, [], `Vietnamese left in English output:\n${leaks.join("\n")}`);

const gateway = (status = "PENDING") => {
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).endsWith("/v2/payment-requests") ? { code: "00", data: { checkoutUrl: "https://pay.payos.vn/web/abc", paymentLinkId: "abc" } } : { code: "00", data: { status, amount: 100_000, amountPaid: status === "PAID" ? 100_000 : 0 } }),
  });
};
const form = { game: "lol", when: "05/10 19:00", duration: "1" };
const START = NOW + 9 * HOUR;

// ---------------------------------------------------------------- the engine

test("a language is chosen with /ngonngu, or taken from the Discord app once, and a choice always wins", async () => {
  assert.deepEqual(LANGS, ["vi", "en"]);
  assert.equal(langFor("nobody"), "vi");
  assert.equal(langFor("fresh", "vi"), "vi");
  assert.equal(langFor("fresh2", "en-US"), "en");
  assert.equal(getPref("fresh2").source, "auto");
  assert.equal(langFor("fresh2"), "en", "remembered, so private messages follow");
  const i = await env.command("900000000000000020", "ngonngu", { opts: { "ngon-ngu": "vi" } });
  assert.match(textOf(i), /Đã chuyển sang tiếng Việt/);
  setLang("fresh2", "vi", "manual");
  setLang("fresh2", "en", "auto");
  assert.equal(langFor("fresh2", "en-GB"), "vi", "a detected locale never overrides a choice");
  assert.throws(() => setLang("x", "fr"), /unknown/);
  makeCustomer("900000000000000021");
  const en = await env.command("900000000000000021", "ngonngu", { opts: { "ngon-ngu": "en" } });
  assert.match(textOf(en), /Switched to English/);
  assert.equal(langFor("900000000000000021"), "en");
});

test("Vietnamese is untouched, English strings are matched whole or by pattern, and unknown text is kept", () => {
  assert.equal(translate("Chờ thanh toán", "vi"), "Chờ thanh toán");
  assert.equal(translate("Chờ thanh toán", "en"), "Awaiting payment");
  assert.equal(translate("Cần đặt trước ít nhất 60 phút.", "en"), "Book at least 60 minutes ahead.");
  assert.equal(translate("Huỷ lịch #12?\nLịch này chưa thanh toán nên huỷ không mất phí.", "en"), "Cancel booking #12?\nThis booking is unpaid, so cancelling costs nothing.");
  assert.equal(translate("Đã huỷ lịch #5. Khách được hoàn 100%. Bạn bị 1 cảnh cáo.", "en"), "Booking #5 cancelled. The customer gets a 100% refund. You get 1 strike.");
  assert.equal(translate("Chờ thanh toán. Một câu lạ không có trong danh mục.", "en"), "Awaiting payment. Một câu lạ không có trong danh mục.", "a sentence with no translation keeps its place");
  assert.equal(translate("Một câu hoàn toàn lạ không có trong danh mục.", "en"), "Một câu hoàn toàn lạ không có trong danh mục.");
  assert.equal(translate("", "en"), "");
  assert.equal(translate(undefined, "en"), undefined);
  assert.equal(translate("  Đã bỏ chờ.  ", "en"), "  Removed from the waiting list.  ");
});

test("days, money and durations written by the shared helpers are rewritten for English readers", () => {
  assert.equal(translate("#12 | T2 05/10 19:00 | 1,5 giờ | 100.000 đ | Đã xác nhận", "en"), "#12 | Mon 05/10 19:00 | 1.5 h | 100,000 VND | Confirmed");
  assert.equal(translate("CN 09:00-12:00; T7 10:00-12:00", "en"), "Sun 09:00-12:00; Sat 10:00-12:00");
  assert.equal(translate("Giá 1.250.000 đ cho 90 phút", "en"), "Giá 1,250,000 VND cho 90 min");
});

test("every catalog entry is a pair, patterns do not collide, and each English text keeps the placeholders of its Vietnamese", () => {
  const seen = new Set();
  for (const [vi, en] of CATALOG) {
    assert.equal(typeof vi, "string");
    assert.equal(typeof en, "string");
    const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(",");
    const used = placeholders(en).split(",").filter(Boolean);
    assert.ok(used.every((p) => placeholders(vi).split(",").includes(p)), `English uses a placeholder the Vietnamese does not have: ${vi}`);
    if (seen.has(vi) && !["chưa có"].includes(vi)) assert.fail(`duplicate entry: ${vi}`);
    seen.add(vi);
    assert.ok(!VIETNAMESE.test(en.replace(/\/[a-z-]+/g, "")), `English text still has Vietnamese: ${en}`);
  }
});

test("a whole message is translated: embeds, fields, buttons, menus and forms", () => {
  const payload = {
    content: "Chọn player bạn muốn đặt lịch:",
    embeds: [new EmbedBuilder().setTitle("Lịch của bạn").setDescription("Bạn chưa có lịch nào. Dùng /datlich để đặt lịch.").addFields({ name: "Giá", value: "100.000 đ" }).setFooter({ text: "Thanh toán trong 30 phút, sau đó lịch tự huỷ." })],
    components: [
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("x").setLabel("Huỷ lịch").setStyle(ButtonStyle.Danger)),
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("y").setPlaceholder("Chọn player").addOptions({ label: "Từ giờ", value: "1", description: "Đến giờ" })),
    ],
  };
  const out = translatePayload(payload, "en");
  const texts = textsOf(out);
  assert.deepEqual(texts, ["Choose the player you want to book:", "Your bookings", "You have no bookings yet. Use /datlich to book.", "Pay within 30 minutes, after that the booking is cancelled automatically.", "Price", "100,000 VND", "Cancel booking", "Choose a player", "From", "To"]);
  const same = translatePayload({ content: "Chọn player bạn muốn đặt lịch:" }, "vi");
  assert.equal(same.content, "Chọn player bạn muốn đặt lịch:");
});

// ---------------------------------------------------------------- the journeys

test("every refusal the rules can give reads in English", () => {
  const details = { status: "Confirmed", action: "cancel", what: "booking", minutes: 60, days: 30, max: 3, min: 50_000, balance: 1_000 };
  const codes = [
    "ILLEGAL_TRANSITION", "FORBIDDEN_ACTOR", "TOO_EARLY", "TOO_LATE", "NOT_FOUND", "INVALID_INPUT", "NOT_ATTESTED", "BLACKLISTED", "SELF_BOOKING", "PLAYER_NOT_ACTIVE", "GAME_NOT_OFFERED",
    "BAD_START", "IN_PAST", "TOO_SOON", "TOO_FAR", "OUTSIDE_AVAILABILITY", "PLAYER_BUSY", "CUSTOMER_BUSY", "TOO_MANY_ACTIVE", "BAD_DURATION", "BAD_RATE", "COUPON_INVALID", "COUPON_EXPIRED",
    "COUPON_USED_UP", "COUPON_ALREADY_USED", "COUPON_MIN_PRICE", "COUPON_NO_EFFECT", "WALLET_LOW", "NOT_EXTENDABLE", "SLOT_HELD", "UNDERPAID", "ORDER_EXISTS", "SETTLED_ALREADY", "PAYOUT_HELD",
    "OPEN_DISPUTE", "NOT_RATEABLE", "ALREADY_RATED", "REVIEW_CLOSED", "BAD_STARS", "ALREADY_PLAYER", "PLAYER_SUSPENDED", "BAD_AVAILABILITY",
  ];
  for (const code of codes) check(code, [translate(new DomainError(code, details).message, "en")]);
  done();
});

test("booking a player, paying, being reminded, cancelling and rating, all in English", async () => {
  gateway();
  const picker = await env.command(IDS.cust, "datlich");
  check("picker", allTexts(picker));
  const open = await env.click(IDS.cust, `pl:book:${IDS.player}`);
  check("form", allTexts(open));
  const pay = await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  check("payment", allTexts(pay));
  for (const [fields, label] of [[{ ...form, when: "bao giờ" }, "bad time"], [{ ...form, duration: "lâu" }, "bad duration"], [{ ...form, when: "01/10 19:00" }, "past"], [{ ...form, game: "dota" }, "wrong game"], [{ ...form, coupon: "SAI" }, "bad coupon"], [{ ...form, repeat: "99" }, "bad repeat"]]) {
    check(label, allTexts(await env.submit(IDS.cust, `bk:new:${IDS.player}`, fields)));
  }
  const busy = await env.submit(IDS.cust2, `bk:new:${IDS.player}`, form);
  check("busy", allTexts(busy));
  check("join waitlist", allTexts(await env.click(IDS.cust2, buttonIds(lastPayload(busy))[0])));

  gateway("PAID");
  await checkPayments(env.client, NOW + MIN);
  check("paid DM", dmTexts(env.client, IDS.cust));
  const customerDms = dmTexts(env.client, IDS.cust).join("\n");
  assert.match(customerDms, /Payment received\. Booking #1 with Player 9000.* at Mon 05\/10 19:00 is confirmed\./);

  await runSchedule(env.client, { now: START - 10 * MIN + 1000 });
  check("reminders", dmTexts(env.client, IDS.cust).concat(dmTexts(env.client, IDS.player)));
  assert.match(dmTexts(env.client, IDS.cust).join("\n"), /Reminder for booking #1, your session with Player 9000.*: in 10 minutes \(Mon 05\/10 19:00\), please join the voice room on time\./);

  const mine = await env.command(IDS.cust, "lichcuatoi");
  check("my bookings", allTexts(mine));
  const ask = await env.click(IDS.cust, "bk:cancel:1");
  check("cancel ask", allTexts(ask));
  const cancelled = await env.click(IDS.cust, "bk:cancel:yes:1");
  check("cancelled", allTexts(cancelled));
  assert.match(textOf(cancelled), /Booking #1 cancelled\./);
  done();
});

test("the rating prompt, the rating form and the thanks are in English", async () => {
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 3 * HOUR, game: "LoL" });
  start(b.id, SYSTEM, NOW + 3 * HOUR);
  complete(b.id, SYSTEM, NOW + 4 * HOUR);
  await runSchedule(env.client, { now: NOW + 4 * HOUR + 30_000 });
  check("rating DM", dmTexts(env.client, IDS.cust));
  assert.match(dmTexts(env.client, IDS.cust).join("\n"), /How was session #1\?/);
  setClock(() => NOW + 4 * HOUR + MIN);
  const open = await env.click(IDS.cust, "bk:rate:1:5");
  check("rating form", allTexts(open));
  const thanks = await env.submit(IDS.cust, "bk:rate:submit:1:5", { review: "great" });
  check("thanks", allTexts(thanks));
  assert.match(textOf(thanks), /Thank you for your rating!/);
  assert.match(buttonLabels(thanks), /Book Player 9000.* again/);
  done();
});
const buttonLabels = (i) => (lastPayload(i).components ?? []).flatMap((r) => r.toJSON().components.map((c) => c.label)).join(" | ");

test("the wallet, top-up packages, points and the wallet payment choice are in English", async () => {
  gateway();
  creditTopup(1, IDS.cust, 300_000, 15_000, NOW);
  check("wallet", allTexts(await env.command(IDS.cust, "vi", { subcommand: "xem" })));
  const packages = await env.command(IDS.cust, "vi", { subcommand: "nap" });
  check("packages", allTexts(packages));
  assert.match(textOf(packages), /Top up 500,000 VND: get 525,000 VND \(5% bonus\)/);
  check("top-up link", allTexts(await env.click(IDS.cust, "wl:topup:500000")));
  check("points", allTexts(await env.command(IDS.cust, "vi", { subcommand: "doi-diem", opts: { "so-diem": 5 } })));
  const choice = await env.submit(IDS.cust, `bk:new:${IDS.player}`, form);
  check("wallet choice", allTexts(choice));
  const paid = await env.click(IDS.cust, "bk:wallet:1");
  check("wallet paid", allTexts(paid));
  assert.match(dmTexts(env.client, IDS.cust).join("\n"), /Paid from your wallet\. Booking #1/);
  done();
});

test("extending a running session, the waiting list and weekly repeats are in English", async () => {
  gateway();
  const b = confirmed({ customerId: IDS.cust, playerId: IDS.player, startAt: NOW + 2 * HOUR, game: "LoL" });
  start(b.id, SYSTEM, NOW + 2 * HOUR);
  setClock(() => NOW + 2 * HOUR + 30 * MIN);
  const offer = await env.click(IDS.cust, `bk:extend:${b.id}`);
  check("extend offer", allTexts(offer));
  check("extend link", allTexts(await env.pick(IDS.cust, `bk:extendpick:${b.id}`, ["30"])));

  // waiting list: told when a slot frees up
  const taken = confirmed({ customerId: IDS.cust2, playerId: IDS.player, startAt: START, game: "LoL" });
  joinWaitlist({ customerId: IDS.cust, playerId: IDS.player, game: "LoL", startAt: START, durationMin: 60 }, NOW);
  cancel(taken.id, actorFor(getBooking(taken.id), IDS.cust2), NOW + 10 * MIN);
  await runWaitlist(env.client, NOW + 11 * MIN);
  const wait = dmTexts(env.client, IDS.cust);
  check("waitlist DM", wait);
  assert.match(wait.join("\n"), /A slot is free! Player 9000.* is available Mon 05\/10 19:00, 1 h, LoL\./);
  check("my waiting list", allTexts(await env.command(IDS.cust, "hangcho")));

  // weekly repeat
  const first = book({ customerId: IDS.cust, playerId: IDS.player, startAt: START + DAY, game: "LoL" });
  createSeries({ bookingId: first.id, weeks: 3 }, NOW);
  await runSeries(env.client, START + DAY + 7 * DAY - 3 * DAY);
  check("series DM", dmTexts(env.client, IDS.cust));
  check("repeat chosen", allTexts(await env.submit(IDS.cust2, `bk:new:${IDS.player}`, { ...form, when: "12/10 19:00", repeat: "3" })));
  done();
});

test("search, bank details, reports, the leaderboard and the 18+ gate are in English", async () => {
  check("search", allTexts(await env.command(IDS.cust, "timplayer", { opts: { game: "LoL" } })));
  check("no result", allTexts(await env.command(IDS.cust, "timplayer", { opts: { game: "Dota" } })));
  check("bank form", allTexts(await env.command(IDS.cust, "nganhang", { subcommand: "cap-nhat" })));
  check("bank saved", allTexts(await env.submit(IDS.cust, "bank:set", { bank: "vcb", number: "123456789", holder: "A B" })));
  check("bank bad", allTexts(await env.submit(IDS.cust, "bank:set", { bank: "zzz", number: "1", holder: "" })));
  check("bank view", allTexts(await env.command(IDS.cust, "nganhang", { subcommand: "xem" })));
  check("report form", allTexts(await env.command(IDS.cust, "baocao")));
  check("report sent", allTexts(await env.submit(IDS.cust, "rp:new:0", { text: "someone was rude in the room" })));
  check("leaderboard", allTexts(await env.command(IDS.cust, "bangxephang")));
  const stranger = "900000000000000030";
  setLang(stranger, "en");
  check("gate", allTexts(await env.command(stranger, "datlich")));
  check("gate wrong", allTexts(await env.submit(stranger, "age:submit", { phrase: "no" })));
  check("gate ok", allTexts(await env.submit(stranger, "age:submit", { phrase: "tôi đã đủ 18 tuổi" })));
  check("limit", allTexts(await env.command(IDS.cust, "nganhang", { subcommand: "xoa" })));
  done();
});

test("a player's own screens are in English: hours picker, earnings, profile forms", async () => {
  check("picker", allTexts(await env.command(IDS.player, "lichranh", { opts: { chon: true } })));
  check("picked", allTexts(await env.pick(IDS.player, "av:day:0.-1.-1", ["1", "2"])));
  check("added", allTexts(await env.click(IDS.player, "av:add:6.19.23")));
  check("bad add", allTexts(await env.click(IDS.player, "av:add:0.-1.-1")));
  check("hours text", allTexts(await env.command(IDS.player, "lichranh", { opts: { lich: "T2 19:00-23:00" } })));
  check("hours bad", allTexts(await env.command(IDS.player, "lichranh", { opts: { lich: "tomorrow" } })));
  check("hours form", allTexts(await env.command(IDS.player, "lichranh")));
  check("earnings", allTexts(await env.command(IDS.player, "thunhap")));
  check("rates form", allTexts(await env.command(IDS.player, "player", { subcommand: "gia-theo-game" })));
  check("rates bad", allTexts(await env.submit(IDS.player, "pl:rates:submit", { rates: "Dota 1" })));
  check("rates ok", allTexts(await env.submit(IDS.player, "pl:rates:submit", { rates: "LoL 120k" })));
  check("media form", allTexts(await env.command(IDS.player, "player", { subcommand: "anh-gioi-thieu" })));
  check("pause", allTexts(await env.command(IDS.player, "player", { subcommand: "tam-nghi" })));
  check("resume", allTexts(await env.command(IDS.player, "player", { subcommand: "nhan-lai" })));
  check("profile form", allTexts(await env.command(IDS.player, "player", { subcommand: "thong-tin" })));
  check("apply form", allTexts(await env.command(IDS.cust, "player", { subcommand: "dang-ky" })));
  check("apply sent", allTexts(await env.submit(IDS.cust, "pl:apply:submit", { name: "Cust", games: "LoL", rate: "100k", bio: "hi", languages: "English" })));
  done();
});

test("a person's language only changes what that person is sent", async () => {
  const toVi = await env.command(IDS.cust2, "ngonngu", { opts: { "ngon-ngu": "vi" } });
  assert.match(textOf(toVi), /Đã chuyển sang tiếng Việt/);
  assert.match(textOf(await env.command(IDS.cust2, "lichcuatoi")), /Bạn chưa có lịch nào/);
  assert.match(textOf(await env.command(IDS.cust, "lichcuatoi")), /You have no bookings yet/);
  assert.match(env.channel("moneyLogChannelId").sent.map((m) => m.content ?? "").join("") || "x", /x|./);
  await sendDm(env.client, IDS.cust2, "Chờ thanh toán");
  await sendDm(env.client, IDS.cust, "Chờ thanh toán");
  assert.deepEqual([dms(env.client, IDS.cust2).at(-1), dms(env.client, IDS.cust).at(-1)], ["Chờ thanh toán", "Awaiting payment"]);
  assert.ok(getSettings() && saveSettings && getDb);
});

test("English apps get English without choosing, and the choice sticks for private messages too", async () => {
  const user = "900000000000000040";
  makeCustomer(user);
  env.guild.addMember({ id: user });
  const i = await (async () => {
    const world = env.world;
    const { makeInteraction } = await import("./discord-fakes.js");
    const x = makeInteraction(world, env.guild.members.cache.get(user), { kind: "command", commandName: "lichcuatoi" });
    x.locale = "en-US";
    await env.router.dispatch(x);
    return x;
  })();
  assert.match(textOf(i), /You have no bookings yet/);
  await sendDm(env.client, user, "Chờ thanh toán");
  assert.equal(dms(env.client, user).at(-1), "Awaiting payment");
});

test("translated text is cut to the limits Discord enforces, so a longer English text can never make a message fail", () => {
  const long = "Chọn ngày và giờ bắt đầu, kết thúc (sau giờ bắt đầu) trước nhé.";
  // Builders refuse long text themselves, so the data is set underneath them, as a long translation would
  const embed = new EmbedBuilder().setTitle("t").addFields({ name: "n", value: "v" });
  Object.assign(embed.data, { title: long.repeat(10), fields: [{ name: long.repeat(10), value: long.repeat(30) }] });
  const button = new ButtonBuilder().setCustomId("x").setLabel("l").setStyle(ButtonStyle.Primary);
  button.data.label = `${long} ${long}`;
  const payload = translatePayload({ content: long.repeat(80), embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] }, "en");
  const label = payload.components[0].toJSON().components[0].label;
  assert.ok(label.length <= 80, `button label is ${label.length} long`);
  const out = payload.embeds[0].toJSON();
  assert.ok(out.title.length <= 256 && out.fields[0].name.length <= 256 && out.fields[0].value.length <= 1024);
  assert.ok(payload.content.length <= 2000);
  assert.ok(label.endsWith("…"), "a cut text says so");
});
