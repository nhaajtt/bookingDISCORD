// Wall-clock helpers on top of Intl (no libraries). All of them take the IANA zone explicitly.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();

function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone) {
  try {
    formatter(timeZone);
    return typeof timeZone === "string" && timeZone.length > 0;
  } catch {
    return false;
  }
}

// The wall clock in `timeZone` at the instant `ms`. weekday is 0 for Sunday.
export function localParts(ms, timeZone) {
  const out = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) out[part.type] = part.value;
  const hour = Number(out.hour) % 24;
  const minute = Number(out.minute);
  const second = Number(out.second);
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute,
    second,
    weekday: WEEKDAYS[out.weekday],
    minuteOfDay: hour * 60 + minute,
  };
}

// Midnight (local) of the day that contains `ms`. Day length is taken as 24 hours, which is exact for zones without daylight saving.
export function startOfLocalDay(ms, timeZone) {
  const p = localParts(ms, timeZone);
  const subSecond = ((ms % 1000) + 1000) % 1000;
  return ms - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - subSecond;
}

const DAY_NAMES = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

// "T2 03/10 19:00", for messages that name a booking time
export function formatLocal(ms, timeZone) {
  const p = localParts(ms, timeZone);
  const two = (n) => String(n).padStart(2, "0");
  return `${DAY_NAMES[p.weekday]} ${two(p.day)}/${two(p.month)} ${two(p.hour)}:${two(p.minute)}`;
}

// parseLocalDateTime("05/10 19:00", timeZone, now) -> ms or null
// For the booking modal. Accepts "DD/MM HH:mm", "DD/MM/YYYY HH:mm", "HH:mm DD/MM", "19h30" and "19h" for the time, with "/", "-" or
// "." between the date parts. Without a year it means the next such date from today (this year, or next year if already past).
// Returns null for anything that is not a real calendar date, or a wall-clock time that does not exist in the zone.
export function parseLocalDateTime(input, timeZone, now = Date.now()) {
  const text = String(input ?? "").toLowerCase().trim();
  const timeMatch = /(\d{1,2})\s*(?::|h)\s*(\d{2})?(?!\d)/.exec(text);
  if (!timeMatch) return null;
  const rest = (text.slice(0, timeMatch.index) + " " + text.slice(timeMatch.index + timeMatch[0].length)).trim();
  const dateMatch = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(rest);
  if (!dateMatch) return null;
  const hour = Number(timeMatch[1]);
  const minute = timeMatch[2] === undefined ? 0 : Number(timeMatch[2]);
  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1) return null;
  const today = localParts(now, timeZone);
  let year = dateMatch[3] ? Number(dateMatch[3]) : today.year;
  const fromWallClock = (y) => {
    const target = Date.UTC(y, month - 1, day, hour, minute);
    if (new Date(target).getUTCMonth() !== month - 1) return null; // 31/02 and friends
    let guess = target;
    for (let i = 0; i < 3; i += 1) {
      const p = localParts(guess, timeZone);
      guess -= Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - target;
    }
    const check = localParts(guess, timeZone);
    return Date.UTC(check.year, check.month - 1, check.day, check.hour, check.minute) === target ? guess : null;
  };
  let result = fromWallClock(year);
  if (!dateMatch[3] && result !== null && result < startOfLocalDay(now, timeZone)) {
    year += 1;
    result = fromWallClock(year);
  }
  return result;
}
