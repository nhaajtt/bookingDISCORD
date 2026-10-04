// A few numbers about the running process, in the text format Prometheus reads. Business numbers (bookings by status, owed money) are
// read from the database when /metrics is asked for; this file only keeps what the process itself knows.

const startedAt = Date.now();
const jobs = new Map();
const counters = new Map();

export function jobFinished(name, { ok, ms, at = Date.now() }) {
  const s = jobs.get(name) ?? { runs: 0, failures: 0, lastRunAt: 0, lastOkAt: 0, lastMs: 0 };
  s.runs += 1;
  s.lastRunAt = at;
  s.lastMs = ms;
  if (ok) s.lastOkAt = at;
  else s.failures += 1;
  jobs.set(name, s);
}

export const jobStates = () => Object.fromEntries(jobs);

export function count(name, labels = {}, by = 1) {
  const key = `${name}${JSON.stringify(labels)}`;
  const entry = counters.get(key) ?? { name, labels, n: 0 };
  entry.n += by;
  counters.set(key, entry);
}

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labelText = (labels) => {
  const keys = Object.keys(labels);
  return keys.length ? `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(",")}}` : "";
};

// renderMetrics(gauges) -> text. gauges is [{ name, help, labels?, value }] supplied by the caller from the database.
export function renderMetrics(gauges = [], now = Date.now()) {
  const lines = [];
  const declared = new Set();
  const emit = (name, help, type, labels, value) => {
    if (!declared.has(name)) {
      declared.add(name);
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    lines.push(`${name}${labelText(labels)} ${value}`);
  };
  emit("booking_bot_uptime_seconds", "Seconds since the process started", "gauge", {}, Math.floor((now - startedAt) / 1000));
  for (const [job, s] of jobs) {
    emit("booking_bot_job_runs_total", "Runs of a background job", "counter", { job }, s.runs);
    emit("booking_bot_job_failures_total", "Failed runs of a background job", "counter", { job }, s.failures);
    emit("booking_bot_job_last_run_timestamp_seconds", "When a job last ran", "gauge", { job }, Math.floor(s.lastRunAt / 1000));
    emit("booking_bot_job_last_success_timestamp_seconds", "When a job last ran without an error", "gauge", { job }, Math.floor(s.lastOkAt / 1000));
    emit("booking_bot_job_last_duration_ms", "How long the last run of a job took", "gauge", { job }, s.lastMs);
  }
  for (const { name, labels, n } of counters.values()) emit(`booking_bot_${name}_total`, name, "counter", labels, n);
  for (const g of gauges) emit(g.name, g.help, "gauge", g.labels ?? {}, g.value);
  return `${lines.join("\n")}\n`;
}
