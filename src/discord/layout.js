import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { config } from "../config.js";
import { getSettings, patchSettings } from "../settings.js";
import { dangerousPermissionsOf } from "./permissions.js";
import { fetchMember } from "./guild.js";
import { agePanel, applyPanel, bookPanel, guidePanel, MARKERS, rulesPanel, supportPanel } from "./panels.js";

// The idempotent layout builder behind /setup. For every role, category and channel: find it by the stored ID, else by name, else
// create it. Permission overwrites are rewritten on every run so a re-run repairs drift. Nothing is ever deleted.

export const ROLE_DEFS = [
  { kind: "verified", key: "verifiedRoleId", name: "Khách", color: 0x95a5a6, granted: true },
  { kind: "player", key: "playerRoleId", name: "Người chơi", color: 0x3498db, granted: true },
  { kind: "trusted", key: "trustedPlayerRoleId", name: "Trusted", color: 0xf1c40f, granted: true },
  { kind: "regular", key: "regularCustomerRoleId", name: "Khách quen", color: 0x2ecc71, granted: true },
  { kind: "staff", key: "staffRoleId", name: "Staff", color: 0xe67e22, granted: false },
];

const NO_SEND = [P.SendMessages, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads];
const READ = [P.ViewChannel, P.ReadMessageHistory];
const TALK = [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.EmbedLinks, P.AttachFiles];

// Who sees and who writes, as functions of the role IDs. Each returns permission overwrites (without the bot, added later).
const ACCESS = {
  public: (r, g) => [{ id: g, allow: READ, deny: NO_SEND }],
  verifiedRead: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.verified, allow: READ, deny: NO_SEND }, { id: r.staff, allow: READ }],
  verifiedChat: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.verified, allow: TALK, deny: [P.MentionEveryone] }, { id: r.staff, allow: TALK }],
  players: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.player, allow: TALK, deny: [P.MentionEveryone] }, { id: r.staff, allow: TALK }],
  staffRead: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.staff, allow: READ, deny: NO_SEND }],
  staffTalk: (r, g) => [{ id: g, deny: [P.ViewChannel] }, { id: r.staff, allow: TALK }],
  owner: (r, g, owners) => [{ id: g, deny: [P.ViewChannel] }, { id: r.staff, deny: [P.ViewChannel] }, ...owners.map((id) => ({ id, allow: READ, deny: NO_SEND }))],
  closed: (r, g) => [{ id: g, deny: [P.ViewChannel] }],
};

// Categories and their channels. `panel` is posted (and kept up to date) by the builder.
export const LAYOUT = [
  {
    key: "startCategoryId",
    name: "BẮT ĐẦU",
    access: "public",
    channels: [
      { key: "rulesChannelId", name: "luật-lệ", access: "public", panel: ["rules", rulesPanel] },
      { key: "ageGateChannelId", name: "xác-nhận-18", access: "public", panel: ["age", agePanel] },
      { key: "guideChannelId", name: "hướng-dẫn", access: "verifiedRead", panel: ["guide", guidePanel] },
    ],
  },
  {
    key: "bookingsCategoryId",
    name: "ĐẶT LỊCH",
    access: "verifiedRead",
    channels: [
      { key: "bookChannelId", name: "đặt-lịch", access: "verifiedRead", panel: ["book", bookPanel] },
      { key: "playersChannelId", name: "danh-sách-player", access: "verifiedRead" },
      { key: "feedbackChannelId", name: "đánh-giá", access: "verifiedRead" },
      { key: "supportChannelId", name: "hỗ-trợ", access: "verifiedChat", panel: ["support", supportPanel] },
    ],
  },
  {
    key: "playerCategoryId",
    name: "PLAYER",
    access: "verifiedRead",
    channels: [
      { key: "applyChannelId", name: "đăng-ký-player", access: "verifiedRead", panel: ["apply", applyPanel] },
      { key: "playerCornerChannelId", name: "góc-player", access: "players" },
    ],
  },
  {
    key: "staffCategoryId",
    name: "NHÂN VIÊN",
    access: "staffRead",
    channels: [
      { key: "applicationsChannelId", name: "duyệt-player", access: "staffRead" },
      { key: "disputesChannelId", name: "khiếu-nại", access: "staffTalk" },
      { key: "moneyLogChannelId", name: "sổ-tiền", access: "owner" },
      { key: "bookingsLogChannelId", name: "nhật-ký", access: "staffRead" },
    ],
  },
  { key: "roomsCategoryId", name: "PHÒNG HẸN", access: "closed", channels: [] },
];

const TEXT_TYPE = ChannelType.GuildText;

async function findChannel(guild, id, name, type) {
  if (id) {
    const known = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
    if (known) return { channel: known, how: "id" };
  }
  const byName = guild.channels.cache.find((c) => c.name === name && c.type === type);
  return byName ? { channel: byName, how: "name" } : { channel: null, how: null };
}

// Creates or updates the one message of a panel, found by the marker in its footer
export async function ensurePanel(channel, marker, content, botId) {
  const payload = { ...content, allowedMentions: { parse: [] } };
  const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
  const mine = recent ? [...recent.values()].find((m) => m.author?.id === botId && m.embeds?.[0]?.footer?.text === marker) : null;
  if (mine) {
    await mine.edit(payload);
    return "edited";
  }
  await channel.send(payload);
  return "posted";
}

export async function ensureLayout(guild, { botId = guild.client?.user?.id ?? guild.members?.me?.id } = {}) {
  const report = { created: [], found: [], fixed: [], problems: [] };
  const settings = getSettings();
  const patch = { roles: {}, channels: {} };
  const me = guild.members?.me ?? (await guild.members.fetchMe?.().catch(() => null));

  // Bot permissions
  if (me?.permissions) {
    const need = [["ViewChannel", P.ViewChannel], ["SendMessages", P.SendMessages], ["EmbedLinks", P.EmbedLinks], ["ReadMessageHistory", P.ReadMessageHistory], ["ManageChannels", P.ManageChannels], ["ManageRoles", P.ManageRoles], ["AttachFiles", P.AttachFiles], ["Connect", P.Connect], ["Speak", P.Speak], ["Stream", P.Stream], ["MentionEveryone", P.MentionEveryone], ["CreateInstantInvite", P.CreateInstantInvite], ["AddReactions", P.AddReactions], ["CreatePublicThreads", P.CreatePublicThreads], ["CreatePrivateThreads", P.CreatePrivateThreads], ["SendMessagesInThreads", P.SendMessagesInThreads]];
    const missing = need.filter(([, flag]) => !me.permissions.has(flag)).map(([name]) => name);
    if (missing.length) report.problems.push(`Bot thiếu quyền: ${missing.join(", ")}. Hãy cấp thêm cho role của bot.`);
    if (me.permissions.has(P.Administrator)) report.problems.push("Bot đang có quyền Administrator. Nên bỏ quyền này, bot chỉ cần các quyền kể trên.");
  }

  // Roles
  const roleIds = {};
  for (const def of ROLE_DEFS) {
    const storedId = settings.roles[def.key];
    let role = (storedId && guild.roles.cache.get(storedId)) || guild.roles.cache.find((r) => r.name === def.name) || null;
    if (role) {
      const bad = def.granted ? dangerousPermissionsOf(role) : [];
      if (bad.length) {
        report.problems.push(`Role "${role.name}" có quyền nguy hiểm (${bad.join(", ")}) nên bot không dùng. Hãy tắt các quyền đó rồi chạy /setup lại.`);
        patch.roles[def.key] = null;
        continue;
      }
      report.found.push(`Role ${role.name}`);
    } else {
      role = await guild.roles.create({ name: def.name, colors: { primaryColor: def.color }, permissions: [], mentionable: false, hoist: false, reason: "Dựng server đặt lịch" });
      report.created.push(`Role ${def.name}`);
    }
    roleIds[def.kind] = role.id;
    patch.roles[def.key] = role.id;
  }

  // Role hierarchy: the bot's own role above the four it hands out, below Staff
  const botTop = me?.roles?.highest;
  if (botTop) {
    for (const def of ROLE_DEFS.filter((d) => d.granted && roleIds[d.kind])) {
      const role = guild.roles.cache.get(roleIds[def.kind]);
      if (role && botTop.position <= role.position) report.problems.push(`Role bot phải nằm trên role ${role.name} (kéo role của bot lên cao hơn trong Cài đặt server, Vai trò).`);
    }
    const staff = roleIds.staff ? guild.roles.cache.get(roleIds.staff) : null;
    if (staff && botTop.position >= staff.position) report.problems.push(`Role bot nên nằm dưới role ${staff.name}.`);
  }

  // Categories and channels
  // A permission overwrite for a user needs that user on the server, so owner ids that are not members are skipped and reported
  const owners = [];
  for (const id of config.multiTenant ? [] : config.ownerIds) {
    if (await fetchMember(guild, id)) owners.push(id);
    else report.problems.push(`OWNER_IDS có ${id} nhưng người này chưa vào server nên chưa được cấp quyền xem #sổ-tiền (Administrator vẫn xem được).`);
  }
  const overwritesFor = (access) => {
    const list = ACCESS[access](roleIds, guild.id, owners).filter((o) => o.id);
    // The bot holds every permission the other overwrites allow or deny: Discord refuses overwrites for permissions the bot lacks in the parent
    if (botId) list.push({ id: botId, allow: [...TALK, ...NO_SEND, P.ManageChannels, P.Connect] });
    return list;
  };

  for (const cat of LAYOUT) {
    let { channel: category } = await findChannel(guild, settings.channels[cat.key], cat.name, ChannelType.GuildCategory);
    if (category) {
      report.found.push(`Danh mục ${cat.name}`);
      await category.permissionOverwrites?.set(overwritesFor(cat.access), "Cập nhật quyền");
    } else {
      category = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, permissionOverwrites: overwritesFor(cat.access), reason: "Dựng server đặt lịch" });
      report.created.push(`Danh mục ${cat.name}`);
    }
    patch.channels[cat.key] = category.id;

    for (const def of cat.channels) {
      let { channel } = await findChannel(guild, settings.channels[def.key], def.name, TEXT_TYPE);
      if (channel) {
        await channel.permissionOverwrites?.set(overwritesFor(def.access), "Cập nhật quyền");
        report.found.push(`Kênh #${def.name}`);
      } else {
        channel = await guild.channels.create({ name: def.name, type: TEXT_TYPE, parent: category.id, permissionOverwrites: overwritesFor(def.access), reason: "Dựng server đặt lịch" });
        report.created.push(`Kênh #${def.name}`);
      }
      patch.channels[def.key] = channel.id;
      if (def.panel) {
        const [marker, build] = def.panel;
        const result = await ensurePanel(channel, MARKERS[marker], build(getSettings()), botId);
        if (result === "edited") report.fixed.push(`Cập nhật bảng trong #${def.name}`);
      }
    }
  }

  patchSettings(patch);
  return report;
}
