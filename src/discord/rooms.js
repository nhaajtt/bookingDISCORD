import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits as P } from "discord.js";
import { setRooms } from "../domain/bookings.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { isGone, mentionOnly } from "./respond.js";
import { durationText } from "./text.js";
import { mention } from "./guild.js";
import { alertButton } from "./trustui.js";
import { log } from "../log.js";

// The private rooms of a booking. Only the two people, the staff role (text read only, voice view only until a dispute) and the bot see them.

export const roomNames = (bookingId) => ({ text: `lich-${bookingId}-text`, voice: `lich-${bookingId}-voice` });

const PEOPLE_TEXT = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles];
const PEOPLE_VOICE = [P.ViewChannel, P.Connect, P.Speak, P.Stream];
const PEOPLE_DENY = [P.MentionEveryone, P.CreateInstantInvite];

// The permission overwrites of both rooms, as plain data so a test can check them exactly
export function roomOverwrites(guild, booking, botId, settings = getSettings()) {
  const people = [booking.customer_id, booking.player_id];
  const staffId = settings.roles.staffRoleId;
  const bot = { id: botId, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.ManageChannels] };
  const text = [
    { id: guild.id, deny: [P.ViewChannel] },
    ...people.map((id) => ({ id, allow: PEOPLE_TEXT, deny: PEOPLE_DENY })),
    ...(staffId ? [{ id: staffId, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] }] : []),
    bot,
  ];
  const voice = [
    { id: guild.id, deny: [P.ViewChannel] },
    ...people.map((id) => ({ id, allow: PEOPLE_VOICE, deny: PEOPLE_DENY })),
    ...(staffId ? [{ id: staffId, allow: [P.ViewChannel], deny: [P.Connect] }] : []),
    bot,
  ];
  return { text, voice };
}

// Creates both rooms, records them with setRooms, and posts the welcome. If the second room fails the first is removed again, so a
// retry on the next tick never leaves strays behind.
export async function openRooms(guild, booking, now, botId = guild.client?.user?.id ?? guild.members?.me?.id, settings = getSettings()) {
  const parent = settings.channels.roomsCategoryId && guild.channels.cache.has(settings.channels.roomsCategoryId) ? settings.channels.roomsCategoryId : null;
  const names = roomNames(booking.id);
  const overwrites = roomOverwrites(guild, booking, botId, settings);
  const text = await guild.channels.create({ name: names.text, type: ChannelType.GuildText, parent, permissionOverwrites: overwrites.text, reason: `Phòng lịch #${booking.id}` });
  let voice;
  try {
    voice = await guild.channels.create({ name: names.voice, type: ChannelType.GuildVoice, parent, userLimit: 2, permissionOverwrites: overwrites.voice, reason: `Phòng lịch #${booking.id}` });
  } catch (error) {
    await text.delete("Tạo phòng voice thất bại").catch(() => {});
    throw error;
  }
  setRooms(booking.id, text.id, voice.id, now);
  const row = new ActionRowBuilder().addComponents(
    ...(settings.maxExtendMin > 0 ? [new ButtonBuilder().setCustomId(`bk:extend:${booking.id}`).setLabel("Gia hạn").setStyle(ButtonStyle.Success)] : []),
    new ButtonBuilder().setCustomId(`bk:problem:${booking.id}`).setLabel("Báo cáo sự cố").setStyle(ButtonStyle.Danger),
    alertButton(booking.id),
    new ButtonBuilder().setCustomId(`bk:cancel:${booking.id}`).setLabel("Huỷ lịch").setStyle(ButtonStyle.Secondary),
  );
  await text
    .send({
      content: `Chào ${mention(booking.customer_id)} và ${mention(booking.player_id)}. Buổi hẹn bắt đầu lúc ${formatLocal(booking.start_at, settings.timezone)}, kéo dài ${durationText(booking.duration_min)}. Cả hai vào phòng voice nhé. Chỉ trò chuyện và chơi game lành mạnh. Có vấn đề, bấm Báo cáo sự cố.`,
      components: [row],
      allowedMentions: mentionOnly(booking.customer_id, booking.player_id),
    })
    .catch((error) => log.error("room.welcome_failed", { booking: booking.id, error }));
  return { text, voice };
}

async function find(guild, id) {
  if (!id) return null;
  return guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null)) ?? null;
}

// Deletes both rooms. A room that is already gone counts as closed. Throws only for a real failure (so the action is retried).
export async function closeRooms(guild, booking) {
  for (const id of [booking.text_channel_id, booking.voice_channel_id]) {
    const channel = await find(guild, id);
    if (!channel) continue;
    try {
      await channel.delete(`Lịch #${booking.id} đã kết thúc`);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
}

// Staff may join the voice room only once a dispute is open (the overwrite is added then, the limit becomes 3)
export async function allowStaffInVoice(guild, booking, settings = getSettings()) {
  const voice = await find(guild, booking.voice_channel_id);
  const staffId = settings.roles.staffRoleId;
  if (!voice || !staffId) return false;
  await voice.permissionOverwrites.edit(staffId, { ViewChannel: true, Connect: true, Speak: true });
  await voice.setUserLimit?.(3);
  return true;
}

// Who is in a booking's voice room right now, from the GuildVoiceStates cache
export async function voiceMembers(guild, booking) {
  const voice = await find(guild, booking.voice_channel_id);
  return voice?.members ? [...voice.members.keys()] : [];
}
