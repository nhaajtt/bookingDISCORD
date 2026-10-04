// A booted fake server: the real router with every real command and flow, a guild built by the real /setup, a fixed clock.
import { fresh, NOW } from "./helpers.js";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRouter } from "../src/discord/router.js";
import { resetLimits } from "../src/discord/limits.js";
import { setClock } from "../src/discord/clock.js";
import { installNotifier } from "../src/discord/notify.js";
import { getSettings } from "../src/settings.js";
import { resetScheduleState } from "../src/jobs/schedule.js";
import { makeWorld, makeInteraction, makeOwner, person } from "./discord-fakes.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

export async function loadModules() {
  const modules = [];
  for (const folder of ["commands", "flows"]) {
    for (const file of readdirSync(path.join(root, folder)).filter((f) => f.endsWith(".js"))) {
      modules.push((await import(pathToFileURL(path.join(root, folder, file)).href)).default);
    }
  }
  return modules;
}

export const IDS = { owner: "900000000000000001", staff: "900000000000000002", cust: "900000000000000003", cust2: "900000000000000004", player: "900000000000000005", player2: "900000000000000006", rando: "900000000000000007" };

// boot({ setup: true }) -> env with helpers to act as a person
export async function boot({ setup = true } = {}) {
  fresh();
  resetLimits();
  resetScheduleState();
  setClock(() => NOW);
  const world = makeWorld();
  installNotifier(world.client);
  const router = createRouter(await loadModules());
  const env = { world, router, client: world.client, guild: world.guild };

  const dispatch = async (user, options) => {
    const i = makeInteraction(world, typeof user === "string" ? person(world, user) : user, options);
    await router.dispatch(i);
    return i;
  };
  env.command = (user, commandName, { subcommand, opts } = {}) => dispatch(user, { kind: "command", commandName, subcommand, opts });
  env.click = (user, customId, message = null) => dispatch(user, { kind: "button", customId, message });
  env.dmClick = (user, customId) => dispatch(user, { kind: "button", customId, dm: true });
  env.dmSubmit = (user, customId, fields = {}) => dispatch(user, { kind: "modal", customId, fields, dm: true });
  env.submit = (user, customId, fields = {}, message = null) => dispatch(user, { kind: "modal", customId, fields, message });
  env.pick = (user, customId, values) => dispatch(user, { kind: "select", customId, values });
  env.autocomplete = (user, commandName, { focused = "", opts } = {}) => dispatch(user, { kind: "autocomplete", commandName, focused, opts });

  env.owner = makeOwner(world, IDS.owner);
  if (setup) {
    await env.command(env.owner, "setup");
    env.staff = person(world, IDS.staff, { roles: [getSettings().roles.staffRoleId] });
  }
  env.channel = (key) => world.guild.channels.cache.get(getSettings().channels[key]);
  env.role = (key) => getSettings().roles[key];
  return env;
}

export { NOW };
