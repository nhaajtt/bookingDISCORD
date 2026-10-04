// Fakes of the parts of discord.js the Discord layer touches: a guild with roles, channels and members, a client with DMs,
// and interactions that record every reply. Import after ./helpers.js (it sets the environment).
import "./helpers.js";
import { Collection, PermissionFlagsBits as P } from "discord.js";
import { config } from "../src/config.js";

let counter = 200000000000000000n;
export const nextId = () => String((counter += 1n));

export const BOT_ID = "300000000000000001";

export class Perms {
  constructor(flags = []) {
    this.flags = new Set(flags);
  }
  has(flag) {
    return this.flags.has(P.Administrator) || this.flags.has(flag);
  }
}

const embedJson = (e) => (typeof e?.toJSON === "function" ? e.toJSON() : e);
const rowJson = (r) => (typeof r?.toJSON === "function" ? r.toJSON() : r);

export class FakeMessage {
  constructor(channel, payload, authorId) {
    this.id = nextId();
    this.channel = channel;
    this.author = { id: authorId };
    this.edits = [];
    this.apply(payload);
  }
  apply(payload) {
    if (payload.content !== undefined) this.content = payload.content;
    if (payload.embeds) this.embeds = payload.embeds.map(embedJson);
    if (payload.components) this.components = payload.components.map(rowJson);
    this.allowedMentions = payload.allowedMentions;
  }
  async edit(payload) {
    this.edits.push(payload);
    this.apply(payload);
    return this;
  }
  async delete() {
    this.deleted = true;
  }
}

export class FakeChannel {
  constructor(guild, options) {
    this.guild = guild;
    this.id = nextId();
    this.name = options.name;
    this.type = options.type;
    this.parentId = options.parent ?? null;
    this.userLimit = options.userLimit ?? 0;
    this.overwrites = options.permissionOverwrites ?? [];
    this.sent = [];
    this.members = new Collection();
    this.deleted = false;
    this.failSend = false;
    const self = this;
    this.permissionOverwrites = {
      set: async (list) => {
        self.overwrites = list;
        self.overwriteSets = (self.overwriteSets ?? 0) + 1;
      },
      edit: async (id, change) => {
        self.overwriteEdits = [...(self.overwriteEdits ?? []), { id, change }];
      },
    };
    this.messages = {
      fetch: async (arg) => {
        if (typeof arg === "string") {
          const found = self.sent.find((m) => m.id === arg && !m.deleted);
          if (!found) throw Object.assign(new Error("Unknown Message"), { code: 10008 });
          return found;
        }
        return new Collection(self.sent.filter((m) => !m.deleted).slice(-(arg?.limit ?? 50)).map((m) => [m.id, m]));
      },
    };
  }
  async send(payload) {
    if (this.failSend) throw Object.assign(new Error("Missing Access"), { code: 50001 });
    const message = new FakeMessage(this, payload, BOT_ID);
    this.sent.push(message);
    return message;
  }
  async delete() {
    if (this.failDelete) throw new Error("Discord is down");
    this.deleted = true;
    this.guild.channels.cache.delete(this.id);
  }
  async setUserLimit(n) {
    this.userLimit = n;
  }
}

export class FakeMember {
  constructor(guild, { id, roles = [], admin = false, bot = false, name }) {
    this.id = id;
    this.guild = guild;
    this.user = { id, bot, username: name ?? `user${id.slice(-4)}`, displayName: name ?? `user${id.slice(-4)}` };
    this.displayName = this.user.displayName;
    this.permissions = new Perms(admin ? [P.Administrator] : []);
    this.failRoleChange = false;
    const self = this;
    this.roles = {
      cache: new Collection(roles.map((roleId) => [roleId, guild.roles.cache.get(roleId) ?? { id: roleId }])),
      add: async (roleId) => {
        if (self.failRoleChange) throw new Error("Missing Permissions");
        self.roles.cache.set(roleId, guild.roles.cache.get(roleId) ?? { id: roleId });
      },
      remove: async (roleId) => {
        if (self.failRoleChange) throw new Error("Missing Permissions");
        self.roles.cache.delete(roleId);
      },
    };
  }
}

export class FakeGuild {
  constructor(client) {
    this.client = client;
    this.id = "100000000000000002";
    this.nextPosition = 0;
    const self = this;
    this.roles = {
      cache: new Collection(),
      everyone: { id: this.id },
      create: async (options) => {
        const role = { id: nextId(), name: options.name, position: (self.nextPosition += 10), permissions: new Perms(options.permissions ?? []) };
        self.roles.cache.set(role.id, role);
        self.created.push(`role:${role.name}`);
        return role;
      },
    };
    this.channels = {
      cache: new Collection(),
      create: async (options) => {
        const channel = new FakeChannel(self, options);
        self.channels.cache.set(channel.id, channel);
        self.created.push(`channel:${options.name}`);
        return channel;
      },
      fetch: async (id) => {
        const found = self.channels.cache.get(id);
        if (!found) throw Object.assign(new Error("Unknown Channel"), { code: 10003 });
        return found;
      },
    };
    this.members = {
      cache: new Collection(),
      me: null,
      fetch: async (id) => {
        const member = self.members.cache.get(id);
        if (!member) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        return member;
      },
    };
    this.created = [];
  }
  addMember(options) {
    const member = new FakeMember(this, options);
    this.members.cache.set(member.id, member);
    return member;
  }
  channelNamed(name) {
    return this.channels.cache.find((c) => c.name === name);
  }
  roleNamed(name) {
    return this.roles.cache.find((r) => r.name === name);
  }
}

class FakeUser {
  constructor(client, id) {
    this.id = id;
    this.client = client;
  }
  async send(payload) {
    if (this.client.closedDms.has(this.id)) throw Object.assign(new Error("Cannot send messages to this user"), { code: 50007 });
    const message = new FakeMessage({ id: `dm-${this.id}` }, payload, BOT_ID);
    this.client.dmLog.push({ userId: this.id, payload, message });
    const list = this.client.dmChannels.get(this.id) ?? [];
    list.push(message);
    this.client.dmChannels.set(this.id, list);
    return message;
  }
  async createDM() {
    const list = this.client.dmChannels.get(this.id) ?? [];
    return { messages: { fetch: async () => new Collection(list.map((m) => [m.id, m])) } };
  }
}

export function makeClient() {
  const client = {
    user: { id: BOT_ID },
    dmLog: [],
    dmChannels: new Map(),
    closedDms: new Set(),
    notified: [],
    guilds: { cache: new Collection(), fetch: async () => null },
    users: { fetch: async (id) => new FakeUser(client, id) },
  };
  return client;
}

// dms(client, userId) -> the texts sent to one person by DM
export const dms = (client, userId) => client.dmLog.filter((d) => d.userId === userId).map((d) => (typeof d.payload === "string" ? d.payload : d.payload.content ?? ""));

// A guild with the bot in it: its role sits between the four granted roles and Staff, and it has exactly the permissions it needs
export function makeWorld() {
  const client = makeClient();
  const guild = new FakeGuild(client);
  client.guilds.cache.set(guild.id, guild);
  guild.botRole = { id: nextId(), name: "bot", position: 45, permissions: new Perms([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.ManageChannels, P.ManageRoles, P.AttachFiles, P.Connect, P.Speak, P.Stream, P.MentionEveryone, P.CreateInstantInvite, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads]) };
  guild.roles.cache.set(guild.botRole.id, guild.botRole);
  const me = guild.addMember({ id: BOT_ID, bot: true, name: "bot" });
  me.permissions = guild.botRole.permissions;
  me.roles.cache.set(guild.botRole.id, guild.botRole);
  me.roles.highest = guild.botRole;
  guild.members.me = me;
  return { client, guild };
}

// ---------------------------------------------------------------- interactions

export function makeInteraction(world, user, options = {}) {
  const { kind = "command", commandName, customId, subcommand, opts = {}, fields = {}, message = null, values = null, focused = "" } = options;
  const dm = Boolean(options.dm);
  const member = dm ? null : world.guild.members.cache.get(user.id) ?? world.guild.addMember({ id: user.id });
  const out = [];
  const interaction = {
    client: world.client,
    guild: dm ? null : world.guild,
    guildId: dm ? null : options.guildId ?? world.guild.id,
    user: member?.user ?? { id: user.id, bot: false, username: `user${user.id.slice(-4)}` },
    member,
    commandName,
    customId,
    message,
    values,
    deferred: false,
    replied: false,
    out,
    isChatInputCommand: () => kind === "command",
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    isStringSelectMenu: () => kind === "select",
    isAutocomplete: () => kind === "autocomplete",
    options: {
      getSubcommand: () => subcommand,
      getUser: (name) => opts[name] ?? null,
      getString: (name) => opts[name] ?? null,
      getInteger: (name) => opts[name] ?? null,
      getBoolean: (name) => opts[name] ?? null,
      getNumber: (name) => opts[name] ?? null,
      get: (name) => (opts[name] === undefined ? null : { value: opts[name]?.id ?? opts[name] }),
      getFocused: () => focused,
    },
    fields: { getTextInputValue: (id) => String(fields[id] ?? "") },
    async reply(payload) {
      this.replied = true;
      out.push({ type: "reply", payload });
    },
    async deferReply(payload) {
      this.deferred = true;
      out.push({ type: "defer", payload });
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async editReply(payload) {
      out.push({ type: "edit", payload });
    },
    async followUp(payload) {
      out.push({ type: "followUp", payload });
    },
    async update(payload) {
      out.push({ type: "update", payload });
    },
    async showModal(modal) {
      out.push({ type: "modal", modal });
    },
    async respond(choices) {
      out.push({ type: "autocomplete", choices });
    },
  };
  return interaction;
}

// The text a person would read from everything the interaction answered
export function textOf(interaction) {
  const parts = [];
  for (const o of interaction.out) {
    const p = o.payload;
    if (typeof p === "string") parts.push(p);
    else if (p) {
      if (p.content) parts.push(p.content);
      for (const e of p.embeds ?? []) {
        const json = embedJson(e);
        parts.push([json.title, json.description, ...(json.fields ?? []).map((f) => `${f.name}: ${f.value}`), json.footer?.text].filter(Boolean).join("\n"));
      }
    }
  }
  return parts.join("\n");
}

export const lastPayload = (interaction) => [...interaction.out].reverse().find((o) => o.payload)?.payload;
export const modalOf = (interaction) => interaction.out.find((o) => o.type === "modal")?.modal;

// All custom ids of the buttons in a payload
export function buttonIds(payload) {
  const ids = [];
  for (const row of payload?.components ?? []) {
    const json = rowJson(row);
    for (const c of json.components ?? []) if (c.custom_id) ids.push(c.custom_id);
  }
  return ids;
}

export const isEphemeral = (entry) => Boolean(entry.payload?.flags) || entry.type === "defer";

// A person on the server. Roles are role ids.
export function person(world, id, extra = {}) {
  return world.guild.members.cache.get(id) ?? world.guild.addMember({ id, ...extra });
}

export function makeOwner(world, id = "900000000000000001") {
  return person(world, id, { admin: true, name: "chu" });
}

// Pushes an id into config.ownerIds for the length of a test
export function withOwnerIds(ids, fn) {
  const before = [...config.ownerIds];
  config.ownerIds.push(...ids);
  return Promise.resolve(fn()).finally(() => {
    config.ownerIds.length = 0;
    config.ownerIds.push(...before);
  });
}

export { P };
