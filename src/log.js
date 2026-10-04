// Structured logging: one line per event, JSON when LOG_FORMAT=json (for log shippers), readable text otherwise.
// LOG_LEVEL is debug, info, warn or error (default info). Fields never include secrets; callers pass ids and counts only.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = () => LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

let sink = null;
// Tests capture output here; pass null to go back to the console
export function setLogSink(fn) {
  sink = fn;
}

function errorFields(error) {
  if (!error) return {};
  if (typeof error === "string") return { error };
  return { error: error.message ?? String(error), code: error.code, ...(process.env.LOG_STACK ? { stack: error.stack } : {}) };
}

function emit(level, event, fields = {}) {
  if (LEVELS[level] < threshold()) return;
  const { error, ...rest } = fields;
  const record = { time: new Date().toISOString(), level, event, ...rest, ...errorFields(error) };
  if (sink) return sink(record);
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (process.env.LOG_FORMAT === "json") return stream(JSON.stringify(record));
  const { time, level: _l, event: _e, ...extra } = record;
  const tail = Object.entries(extra).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  stream(`${time} ${level.toUpperCase()} ${event}${tail ? ` ${tail}` : ""}`);
}

export const log = {
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
};
