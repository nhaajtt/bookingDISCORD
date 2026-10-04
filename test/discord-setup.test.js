import { fresh } from "./helpers.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelType } from "discord.js";
import { CHANNEL_KEYS, ROLE_KEYS, getSettings } from "../src/settings.js";
import setup from "../src/commands/setup.js";
import { resetLimits } from "../src/discord/limits.js";
import { setClock } from "../src/discord/clock.js";
import { makeWorld, makeInteraction, makeOwner, person, textOf, buttonIds, Perms, P, withOwnerIds } from "./discord-fakes.js";

beforeEach(() => {
  fresh();
  resetLimits();
  setClock();
});

async function runSetup(world, user) {
  const i = makeInteraction(world, user, { commandName: "setup" });
  await setup.execute(i);
  return i;
}

test("/setup builds every role, category and channel, stores every id and posts the panels", async () => {
  const world = makeWorld();
  const owner = makeOwner(world);
  const i = await runSetup(world, owner);

  for (const name of ["Khách", "Người chơi", "Trusted", "Khách quen", "Staff"]) assert.ok(world.guild.roleNamed(name), name);
  for (const name of ["luật-lệ", "xác-nhận-18", "hướng-dẫn", "đặt-lịch", "danh-sách-player", "đánh-giá", "hỗ-trợ", "đăng-ký-player", "góc-player", "duyệt-player", "khiếu-nại", "sổ-tiền", "nhật-ký"]) {
    assert.ok(world.guild.channelNamed(name), name);
  }
  for (const name of ["BẮT ĐẦU", "ĐẶT LỊCH", "PLAYER", "NHÂN VIÊN", "PHÒNG HẸN"]) assert.equal(world.guild.channelNamed(name)?.type, ChannelType.GuildCategory, name);

  const s = getSettings();
  for (const key of CHANNEL_KEYS) assert.ok(s.channels[key], key);
  for (const key of ROLE_KEYS) assert.ok(s.roles[key], key);
  assert.equal(s.roles.verifiedRoleId, world.guild.roleNamed("Khách").id);
  assert.equal(s.channels.roomsCategoryId, world.guild.channelNamed("PHÒNG HẸN").id);

  assert.deepEqual(buttonIds(world.guild.channelNamed("xác-nhận-18").sent[0]), ["age:open"]);
  assert.deepEqual(buttonIds(world.guild.channelNamed("đăng-ký-player").sent[0]), ["pl:apply"]);
  assert.deepEqual(buttonIds(world.guild.channelNamed("đặt-lịch").sent[0]), ["bk:pick"]);
  assert.match(textOf({ out: [{ payload: world.guild.channelNamed("luật-lệ").sent[0] }] }), /18 tuổi/);
  assert.match(textOf(i), /Đã tạo/);
});

test("running /setup again creates nothing and posts nothing twice", async () => {
  const world = makeWorld();
  const owner = makeOwner(world);
  await runSetup(world, owner);
  const created = world.guild.created.length;
  const before = getSettings();
  const second = await runSetup(world, owner);
  assert.equal(world.guild.created.length, created, "no role or channel is created twice");
  assert.deepEqual(getSettings().channels, before.channels);
  assert.deepEqual(getSettings().roles, before.roles);
  for (const name of ["luật-lệ", "xác-nhận-18", "hướng-dẫn", "đặt-lịch", "đăng-ký-player", "hỗ-trợ"]) {
    assert.equal(world.guild.channelNamed(name).sent.length, 1, `${name} keeps one panel`);
    assert.equal(world.guild.channelNamed(name).sent[0].edits.length, 1, `${name} panel is edited in place`);
  }
  assert.match(textOf(second), /Đã có sẵn/);
});

test("stored ids beat names, and an existing role or channel is found by name", async () => {
  const world = makeWorld();
  const owner = makeOwner(world);
  // A server that already has some of the pieces by hand
  const staff = await world.guild.roles.create({ name: "Staff" });
  const rules = await world.guild.channels.create({ name: "luật-lệ", type: ChannelType.GuildText });
  world.guild.created.length = 0;
  await runSetup(world, owner);
  assert.equal(getSettings().roles.staffRoleId, staff.id);
  assert.equal(getSettings().channels.rulesChannelId, rules.id);
  assert.ok(!world.guild.created.includes("role:Staff"));
  assert.equal(world.guild.channels.cache.filter((c) => c.name === "luật-lệ").size, 1);

  // Renaming a channel by hand does not make the bot create a second one
  const renamed = world.guild.channelNamed("hướng-dẫn");
  renamed.name = "huong-dan-moi";
  const count = world.guild.channels.cache.size;
  await runSetup(world, owner);
  assert.equal(world.guild.channels.cache.size, count);
});

test("permission overwrites: the door is public, the rest needs the Khách role, money is owner only, rooms are closed", async () => {
  const world = makeWorld();
  const owner = makeOwner(world);
  person(world, "900000000000000077");
  await withOwnerIds(["900000000000000077"], () => runSetup(world, owner));
  const everyone = world.guild.id;
  const verified = world.guild.roleNamed("Khách").id;
  const staff = world.guild.roleNamed("Staff").id;
  const player = world.guild.roleNamed("Người chơi").id;
  const ow = (name) => world.guild.channelNamed(name).overwrites;
  const of = (name, id) => ow(name).find((o) => o.id === id);

  assert.ok(of("luật-lệ", everyone).allow.includes(P.ViewChannel));
  assert.ok(of("luật-lệ", everyone).deny.includes(P.SendMessages));
  assert.ok(of("đặt-lịch", everyone).deny.includes(P.ViewChannel));
  assert.ok(of("đặt-lịch", verified).allow.includes(P.ViewChannel));
  assert.ok(of("đặt-lịch", verified).deny.includes(P.SendMessages));
  assert.ok(of("hỗ-trợ", verified).allow.includes(P.SendMessages));
  assert.ok(of("góc-player", player).allow.includes(P.SendMessages));
  assert.equal(of("góc-player", verified), undefined, "customers never see the players' corner");
  assert.ok(of("duyệt-player", everyone).deny.includes(P.ViewChannel));
  assert.equal(of("duyệt-player", verified), undefined, "verified members never see staff channels");
  assert.ok(of("duyệt-player", staff).allow.includes(P.ViewChannel));
  assert.ok(of("sổ-tiền", staff).deny.includes(P.ViewChannel), "staff cannot read the money log");
  assert.ok(of("sổ-tiền", "900000000000000077").allow.includes(P.ViewChannel), "an owner id can");
  assert.deepEqual(ow("PHÒNG HẸN").filter((o) => o.id !== "300000000000000001").map((o) => o.id), [everyone]);
  for (const name of ["đặt-lịch", "sổ-tiền", "PHÒNG HẸN"]) assert.ok(ow(name).some((o) => o.id === "300000000000000001"), `${name} lets the bot in`);
});

test("a role with powerful permissions is reported and never used", async () => {
  const world = makeWorld();
  const owner = makeOwner(world);
  const risky = await world.guild.roles.create({ name: "Khách", permissions: [P.ManageMessages, P.BanMembers] });
  world.guild.created.length = 0;
  const i = await runSetup(world, owner);
  assert.equal(getSettings().roles.verifiedRoleId, null);
  assert.ok(!world.guild.created.includes("role:Khách"), "no second role with the same name is made");
  assert.match(textOf(i), /ManageMessages/);
  assert.match(textOf(i), /BanMembers/);
  assert.ok(world.guild.roles.cache.has(risky.id));
  assert.ok(getSettings().roles.playerRoleId, "the safe roles are still set up");
});

test("a bot role that sits too low, an Administrator bot and missing permissions are reported", async () => {
  const world = makeWorld();
  const owner = makeOwner(world);
  world.guild.botRole.position = 1;
  let i = await runSetup(world, owner);
  assert.match(textOf(i), /Role bot phải nằm trên/);

  const high = makeWorld();
  high.guild.botRole.position = 999;
  i = await runSetup(high, makeOwner(high));
  assert.match(textOf(i), /nên nằm dưới role Staff/);

  const weak = makeWorld();
  weak.guild.members.me.permissions = new Perms([P.ViewChannel]);
  i = await runSetup(weak, makeOwner(weak));
  assert.match(textOf(i), /Bot thiếu quyền: .*ManageChannels/);

  const admin = makeWorld();
  admin.guild.members.me.permissions = new Perms([P.Administrator]);
  i = await runSetup(admin, makeOwner(admin));
  assert.match(textOf(i), /Administrator/);
});

test("a clean server reports no problems", async () => {
  const world = makeWorld();
  const i = await runSetup(world, makeOwner(world));
  assert.match(textOf(i), /Cần sửa: Không có/);
});

test("only an owner may run /setup", async () => {
  const world = makeWorld();
  const normal = person(world, "900000000000000010");
  let i = await runSetup(world, normal);
  assert.match(textOf(i), /không có quyền/);
  assert.equal(world.guild.created.length, 0);

  await runSetup(world, makeOwner(world)); // builds the staff role
  const staff = person(world, "900000000000000011", { roles: [getSettings().roles.staffRoleId] });
  const before = world.guild.created.length;
  i = await runSetup(world, staff);
  assert.match(textOf(i), /không có quyền/);
  assert.equal(world.guild.created.length, before);

  await withOwnerIds(["900000000000000012"], async () => {
    i = await runSetup(world, person(world, "900000000000000012"));
    assert.match(textOf(i), /Kết quả dựng server/);
  });
});

test("the guide panel shows the real cancellation tiers", async () => {
  const world = makeWorld();
  await runSetup(world, makeOwner(world));
  const guide = world.guild.channelNamed("hướng-dẫn").sent[0];
  const text = guide.embeds[0].description;
  assert.match(text, /từ 24 giờ trở lên: hoàn 100%/);
  assert.match(text, /từ 2 đến dưới 24 giờ: hoàn 50%/);
  assert.match(text, /trong vòng 2 giờ trước giờ hẹn: không hoàn tiền/);
  assert.match(text, /bot không giữ tiền/);
});

test("an owner id that is not on the server is reported instead of breaking the build", async () => {
  const world = makeWorld();
  const i = await withOwnerIds(["900000000000000078"], () => runSetup(world, makeOwner(world)));
  assert.match(textOf(i), /OWNER_IDS có 900000000000000078 nhưng người này chưa vào server/);
  assert.ok(world.guild.channelNamed("sổ-tiền"));
  assert.equal(world.guild.channelNamed("sổ-tiền").overwrites.some((o) => o.id === "900000000000000078"), false);
});
