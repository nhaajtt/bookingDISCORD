import { config } from "../config.js";
import { currentTenant } from "../db.js";
import { tagComponents } from "./dmtags.js";
import { langFor, translatePayload } from "../i18n.js";
import { getSettings } from "../settings.js";
import { sanitizeText } from "../domain/ratings.js";
import { mentionOnly } from "./respond.js";
import { log } from "../log.js";

// Looking things up on the one booking server, and sending to people and channels without ever throwing at the caller.

// The booking server of an interaction. Buttons in a DM (rating prompts, reminders) have no guild of their own.
export async function guildOf(interaction) {
  return interaction.guild ?? (await getGuild(interaction.client));
}

export async function getGuild(client) {
  const id = currentTenant() ?? config.guildId;
  const cached = client?.guilds?.cache?.get(id);
  if (cached) return cached;
  try {
    return (await client?.guilds?.fetch?.(id)) ?? null;
  } catch {
    return null;
  }
}

// The channel stored under settings.channels[key], from cache or REST, or null
export async function channelOf(guild, key) {
  const id = getSettings().channels[key];
  if (!id || !guild) return null;
  return guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null)) ?? null;
}

// Posts to a configured log channel. A missing channel or a failed send is logged and returns null, never throws.
export async function postLog(guild, key, payload, users = []) {
  try {
    const channel = await channelOf(guild, key);
    if (!channel) return null;
    const body = typeof payload === "string" ? { content: payload } : { ...payload };
    body.allowedMentions ??= mentionOnly(...users);
    return await channel.send(body);
  } catch (error) {
    log.error("log_channel.post_failed", { key, error });
    return null;
  }
}

// DM; false when the person has DMs closed or anything else goes wrong
export async function sendDm(client, userId, payload) {
  try {
    const user = await client.users.fetch(userId);
    const body = typeof payload === "string" ? { content: payload } : { ...payload };
    body.allowedMentions ??= { parse: [] };
    translatePayload(body, langFor(userId));
    // A button in a private message must say which server it is from (multi-server mode)
    if (config.multiTenant && currentTenant()) tagComponents(body.components, currentTenant());
    await user.send(body);
    return true;
  } catch {
    return false;
  }
}

export const mention = (userId) => `<@${userId}>`;

// A Discord name cleaned for logs and cards, so it can never carry a mention or a link
export const nameOf = (user) => sanitizeText(user?.displayName ?? user?.globalName ?? user?.username ?? user?.id ?? "", 32) || "Người dùng";

// Like fetchMember but tells "not on the server" (Unknown Member) apart from a failure that says nothing about it
export async function fetchMemberState(guild, userId) {
  try {
    return { member: await guild.members.fetch(userId) };
  } catch (error) {
    return error?.code === 10007 ? { gone: true } : { failed: true };
  }
}

// A member by REST, one at a time (no members intent); null when the person is not on the server
export async function fetchMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}
