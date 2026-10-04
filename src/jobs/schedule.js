import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { alert } from "../alerts.js";
import { currentTenant } from "../db.js";
import { SYSTEM, cancel, complete, endOf, expireUnpaid, getBooking, noShow, start } from "../domain/bookings.js";
import { dueActions, loadScheduleState, markActionDone } from "../domain/schedule.js";
import { getPlayer } from "../domain/players.js";
import { MINUTE, formatLocal } from "../domain/time.js";
import { formatVnd } from "../domain/pricing.js";
import { getSettings } from "../settings.js";
import { now } from "../discord/clock.js";
import { getGuild, mention, sendDm } from "../discord/guild.js";
import { afterStrike, audit, moneyLog } from "../discord/moderation.js";
import { isGone } from "../discord/respond.js";
import { closeRooms, openRooms, voiceMembers } from "../discord/rooms.js";
import { fetchMemberState } from "../discord/guild.js";
import { handlePlayerLeft } from "../discord/departures.js";
import { log } from "../log.js";

// One tick of the scheduler: asks the domain what is due, runs each action against Discord, and records the ones that leave no trace
// in the booking's status only after the Discord side succeeded, so a failure is retried on the next tick.

// First-seen time of a possible no-show, so a person who joins in the minute after the grace is not penalised: one more tick is waited
const noShowSeen = new Map();
export const resetScheduleState = () => noShowSeen.clear();
// Booking numbers repeat from server to server in multi-server mode, so the key says which server it is
const pendingNoShow = {
  get: (id) => noShowSeen.get(`${currentTenant() ?? ""}:${id}`),
  set: (id, t) => noShowSeen.set(`${currentTenant() ?? ""}:${id}`, t),
  delete: (id) => noShowSeen.delete(`${currentTenant() ?? ""}:${id}`),
};

const REMINDER_TEXT = {
  reminder24h: (when) => `ngày mai lúc ${when}`,
  reminder1h: (when) => `còn khoảng 1 giờ nữa (${when})`,
  reminder10m: (when) => `còn 10 phút nữa (${when}), hãy vào phòng voice đúng giờ nhé`,
};

const tolerate = (error, codes = ["ILLEGAL_TRANSITION"]) => {
  if (codes.includes(error?.code)) return true;
  throw error;
};

async function roomOf(guild, booking) {
  if (!booking.text_channel_id) return null;
  return guild.channels.cache.get(booking.text_channel_id) ?? (await guild.channels.fetch(booking.text_channel_id).catch(() => null));
}

const say = async (guild, booking, content, users = []) => {
  const room = await roomOf(guild, booking);
  await room?.send({ content, allowedMentions: { parse: [], users } }).catch((error) => log.error("room.message_failed", { booking: booking.id, error }));
};

const ratingRows = (id) => [
  new ActionRowBuilder().addComponents([1, 2, 3, 4, 5].map((n) => new ButtonBuilder().setCustomId(`bk:rate:${id}:${n}`).setLabel(`${n} sao`).setStyle(ButtonStyle.Primary))),
  new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bk:problem:${id}`).setLabel("Báo cáo sự cố").setStyle(ButtonStyle.Danger)),
];

const HANDLERS = {
  async expireUnpaid({ client, guild, booking, t }) {
    try {
      expireUnpaid(booking.id, t);
    } catch (error) {
      return tolerate(error, ["ILLEGAL_TRANSITION", "TOO_EARLY"]);
    }
    await sendDm(client, booking.customer_id, `Lịch #${booking.id} đã hết hạn thanh toán và được huỷ. Bạn có thể đặt lại bằng /datlich.`);
    await audit(guild, `Lịch #${booking.id} hết hạn thanh toán.`);
  },

  async reminder({ client, guild, booking, action, t, settings }) {
    const when = formatLocal(booking.start_at, settings.timezone);
    const phrase = REMINDER_TEXT[action.type](when);
    const player = getPlayer(booking.player_id);
    await sendDm(client, booking.customer_id, `Nhắc lịch #${booking.id}, buổi hẹn với ${player?.displayName ?? "player"}: ${phrase}.`);
    await sendDm(client, booking.player_id, `Nhắc lịch #${booking.id}, buổi hẹn với ${mention(booking.customer_id)}: ${phrase}.`);
    markActionDone(booking.id, action.type, t);
  },

  async openRooms({ client, guild, booking, t, settings }) {
    try {
      await openRooms(guild, booking, t);
    } catch (error) {
      // A player who is no longer on the server cannot get a room: pause them and refund their bookings instead of retrying for ever
      if ((await fetchMemberState(guild, booking.player_id)).gone) {
        await handlePlayerLeft(client, guild, booking.player_id);
        return;
      }
      // Rooms are retried every tick until the start; five minutes after it the owner hears about it
      if (t > booking.start_at + 5 * MINUTE) {
        alert(`Không tạo được phòng cho lịch #${booking.id}: ${error.message}. Hãy tạo phòng thủ công, nhân viên có thể bắt đầu lịch.`);
      }
      throw error;
    }
  },

  async start({ guild, booking, t, settings }) {
    try {
      start(booking.id, SYSTEM, t);
    } catch (error) {
      return tolerate(error, ["ILLEGAL_TRANSITION", "TOO_EARLY", "TOO_LATE"]);
    }
    await say(guild, booking, `Buổi hẹn đã bắt đầu, kết thúc lúc ${formatLocal(endOf(booking), settings.timezone)}.`);
  },

  async noShowCheck({ client, guild, booking, t, settings }) {
    const first = pendingNoShow.get(booking.id);
    if (first === undefined || first >= t) {
      pendingNoShow.set(booking.id, t);
      return;
    }
    const present = new Set(await voiceMembers(guild, booking));
    const customerHere = present.has(booking.customer_id);
    const playerHere = present.has(booking.player_id);
    if (customerHere && playerHere) {
      pendingNoShow.delete(booking.id);
      return;
    }
    const absent = !customerHere && !playerHere ? "both" : customerHere ? "player" : "customer";
    try {
      if (absent === "both") {
        const result = cancel(booking.id, SYSTEM, t, { reason: "cả hai vắng mặt" }, settings);
        const text = `Lịch #${booking.id}: cả hai đều vắng mặt nên lịch được huỷ và hoàn 100% cho khách. Khoản hoàn đã được ghi nhận, chủ server sẽ chuyển lại.`;
        await sendDm(client, booking.customer_id, text);
        await sendDm(client, booking.player_id, `Lịch #${booking.id} đã bị huỷ vì cả hai vắng mặt.`);
        await moneyLog(guild, `Lịch #${booking.id}: cả hai vắng mặt, hoàn ${formatVnd(result.refundVnd)} cho khách.`);
      } else if (absent === "player") {
        const result = noShow(booking.id, "player", SYSTEM, t, settings);
        await say(guild, booking, "Player vắng mặt, khách được hoàn 100%.");
        await sendDm(client, booking.customer_id, `Player vắng mặt ở lịch #${booking.id}, bạn được hoàn 100%. Khoản hoàn đã được ghi nhận, chủ server sẽ chuyển lại cho bạn.`);
        await sendDm(client, booking.player_id, `Bạn vắng mặt ở lịch #${booking.id} nên bị 1 cảnh cáo và khách được hoàn tiền.`);
        await moneyLog(guild, `Lịch #${booking.id}: player vắng mặt, hoàn ${formatVnd(result.refundVnd)} cho khách.`);
        await afterStrike(guild, booking.player_id, result.strike);
      } else {
        noShow(booking.id, "customer", SYSTEM, t, settings);
        await say(guild, booking, "Khách vắng mặt, player vẫn được thanh toán.");
        await sendDm(client, booking.customer_id, `Bạn vắng mặt ở lịch #${booking.id} nên lịch được tính là đã dùng và bạn bị 1 cảnh cáo.`);
        await sendDm(client, booking.player_id, `Khách vắng mặt ở lịch #${booking.id}, bạn vẫn được thanh toán.`);
        await moneyLog(guild, `Lịch #${booking.id}: khách vắng mặt, phần của player được ghi vào sổ.`);
      }
      await audit(guild, `Lịch #${booking.id}: ${absent === "both" ? "cả hai" : absent === "player" ? "player" : "khách"} vắng mặt.`);
    } catch (error) {
      tolerate(error);
    } finally {
      pendingNoShow.delete(booking.id);
    }
  },

  async autoEnd({ guild, booking, t }) {
    try {
      complete(booking.id, SYSTEM, t);
    } catch (error) {
      return tolerate(error, ["ILLEGAL_TRANSITION", "TOO_EARLY"]);
    }
    await say(guild, booking, "Buổi hẹn đã kết thúc, cảm ơn hai bạn.");
  },

  async askRating({ client, guild, booking, t }) {
    const payload = { content: `Bạn thấy buổi hẹn #${booking.id} thế nào?`, components: ratingRows(booking.id), allowedMentions: { parse: [], users: [booking.customer_id] } };
    let delivered = false;
    let transient = false;
    const room = await roomOf(guild, booking);
    if (room) {
      try {
        await room.send({ ...payload, content: `${mention(booking.customer_id)} ${payload.content}` });
        delivered = true;
      } catch (error) {
        if (!isGone(error)) transient = true;
      }
    }
    if (await sendDm(client, booking.customer_id, payload)) delivered = true;
    if (!delivered && transient) throw new Error("rating prompt could not be delivered");
    markActionDone(booking.id, "askRating", t);
  },

  async autoComplete({ client, guild, booking, t }) {
    const strip = async (channel) => {
      try {
        const recent = await channel.messages.fetch({ limit: 15 });
        for (const message of recent.values()) {
          const mine = message.author?.id === client.user?.id && message.components?.some((row) => row.components?.some((c) => String(c.customId ?? c.custom_id ?? "").startsWith(`bk:rate:${booking.id}:`)));
          if (mine) await message.edit({ components: [] });
        }
      } catch {
        // Best effort: the rating handler refuses a late rating anyway
      }
    };
    const room = await roomOf(guild, booking);
    if (room) await strip(room);
    try {
      const user = await client.users.fetch(booking.customer_id);
      await strip(await user.createDM());
    } catch {
      // DMs closed
    }
    markActionDone(booking.id, "autoComplete", t);
  },

  async closeRooms({ guild, booking, t }) {
    await closeRooms(guild, booking);
    markActionDone(booking.id, "closeRooms", t);
  },
};

// One run at a time per server: the voice fast path and the periodic tick never overlap, and the one that finds it busy simply leaves
// the work to the other
const running = new Set();

// runSchedule(client, { now?, bookingId? }): everything that is due, or only the actions of one booking
export async function runSchedule(client, options = {}) {
  const key = currentTenant() ?? "default";
  if (running.has(key)) return { ran: 0, failed: 0, busy: true };
  running.add(key);
  try {
    return await runDue(client, options);
  } finally {
    running.delete(key);
  }
}

async function runDue(client, { now: t = now(), bookingId = null } = {}) {
  const guild = await getGuild(client);
  if (!guild) return { ran: 0, failed: 0 };
  const settings = getSettings();
  const state = loadScheduleState(t, {}, settings);
  if (bookingId !== null) state.bookings = state.bookings.filter((b) => b.id === bookingId);

  // Who is in each voice room, read from the voice-state cache (GuildVoiceStates intent, no member listing)
  for (const b of state.bookings) {
    if (b.status === "CONFIRMED" && b.voice_channel_id) state.voice[b.id] = await voiceMembers(guild, b);
  }

  let ran = 0;
  let failed = 0;
  for (const action of dueActions(state, t)) {
    const booking = getBooking(action.bookingId);
    if (!booking) continue;
    const handler = action.type.startsWith("reminder") ? HANDLERS.reminder : HANDLERS[action.type];
    try {
      await handler({ client, guild, booking, action, t, settings });
      ran += 1;
    } catch (error) {
      failed += 1;
      log.error("schedule.action_failed", { action: action.type, booking: action.bookingId, error });
    }
  }
  return { ran, failed };
}

export default {
  name: "schedule",
  everyMs: 30_000,
  run: (client) => runSchedule(client),
};
