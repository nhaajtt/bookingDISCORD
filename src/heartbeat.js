import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./log.js";

// Writes the current time to data/heartbeat every 30 seconds; src/healthcheck.js reads it
export function startHeartbeat(everyMs = 30_000) {
  mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, "heartbeat");
  const beat = () => {
    try {
      writeFileSync(file, String(Date.now()));
    } catch (error) {
      log.error("heartbeat.failed", { error });
    }
  };
  beat();
  return setInterval(beat, everyMs).unref();
}
