import { Events } from "discord.js";
import { getDb } from "../db.js";
import { runSchedule } from "../jobs/schedule.js";
import { withGuild } from "../tenancy.js";
import { log } from "../log.js";

// A person joining a booking's voice room runs the scheduler for that booking at once, so a session starts the moment both are in
// the room instead of at the next 30 second tick. The tick stays the safety net for everything else.
export default {
  name: Events.VoiceStateUpdate,
  async execute(client, oldState, newState) {
    if (!newState?.channelId || newState.channelId === oldState?.channelId) return;
    await withGuild(newState.guild?.id, async () => {
      const booking = getDb().prepare("SELECT id FROM bookings WHERE voice_channel_id = ? AND status = 'CONFIRMED'").get(newState.channelId);
      if (!booking) return;
      try {
        await runSchedule(client, { bookingId: booking.id });
      } catch (error) {
        log.error("voice.fast_path_failed", { booking: booking.id, error });
      }
    });
  },
};
