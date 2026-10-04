import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { alert } from "./alerts.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { jobFinished } from "./metrics.js";
import { forEachGuild } from "./tenancy.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "jobs");

// Every file in src/jobs exports default { name, everyMs, run(client) }. Each job runs once at start and then on its own timer,
// never overlapping itself, and an error in one job is logged and alerted without stopping the others.
export async function startJobs(client) {
  if (!existsSync(dir)) return [];
  const started = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const { default: job } = await import(pathToFileURL(path.join(dir, file)).href);
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      const began = Date.now();
      let ok = true;
      try {
        // One run per server (a single-server install has exactly one); a failing server does not stop the others
        const results = await forEachGuild(() => job.run(client));
        if (results.length === 0 && config.multiTenant) ok = true;
      } catch (error) {
        ok = false;
        log.error("job.failed", { job: job.name, error });
        alert(`Job ${job.name} lỗi: ${error.message}`);
      } finally {
        running = false;
        jobFinished(job.name, { ok, ms: Date.now() - began });
      }
    };
    setInterval(tick, job.everyMs).unref();
    tick();
    started.push(job.name);
  }
  return started;
}
