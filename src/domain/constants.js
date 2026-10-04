// Timings shared by the booking rules and the scheduler. The values the owner may change live in settings; these are fixed by design.

// Rooms open this long before the start, and a session may be started from that moment
export const ROOM_OPEN_LEAD_MIN = 10;
// Rooms stay this long after a session ended, then they are closed
export const ROOM_CLOSE_DELAY_MIN = 15;
// Reminders, in minutes before the start
export const REMINDER_MIN = { reminder24h: 24 * 60, reminder1h: 60, reminder10m: 10 };
