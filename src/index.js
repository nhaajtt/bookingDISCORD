import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { alert } from "./alerts.js";
import { startHeartbeat } from "./heartbeat.js";
import { startJobs } from "./jobs.js";
import { createRouter } from "./discord/router.js";
import { installNotifier } from "./discord/notify.js";
import { startWebServer } from "./web/server.js";
import { setGuildSource } from "./tenancy.js";
import { log } from "./log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No privileged intents: message content, members and presences are never requested
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });

async function loadFolder(name, onModule) {
  const dir = path.join(__dirname, name);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    onModule((await import(pathToFileURL(path.join(dir, file)).href)).default);
  }
}

// Commands and component-only flows share one router (see src/discord/router.js)
const modules = [];
await loadFolder("commands", (mod) => modules.push(mod));
await loadFolder("flows", (mod) => modules.push(mod));
client.router = createRouter(modules);
client.commands = client.router.commands;
// The payments job reports through this, so it is installed before any job starts
installNotifier(client);
await loadFolder("events", (event) => {
  const register = event.once ? client.once.bind(client) : client.on.bind(client);
  register(event.name, (...args) => event.execute(client, ...args));
});

setGuildSource(() => [...client.guilds.cache.keys()]);

client.once(Events.ClientReady, async () => {
  startHeartbeat();
  try {
    await startWebServer(client);
  } catch (error) {
    log.error("web.start_failed", { error });
    alert(`Không bật được máy chủ web: ${error.message}`);
  }
  log.info("jobs.started", { jobs: await startJobs(client) });
});

process.on("unhandledRejection", (error) => {
  log.error("process.unhandled_rejection", { error });
  alert(`Unhandled rejection: ${error?.message ?? error}`);
});

async function shutdown(signal) {
  log.info("process.shutdown", { signal });
  await client.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await client.login(config.token);
