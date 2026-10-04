import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { REST, Routes } from "discord.js";
import { config } from "./config.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "commands");

const body = [];
if (existsSync(dir)) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const { default: command } = await import(pathToFileURL(path.join(dir, file)).href);
    // /kichhoat only exists in multi-server mode
    if (command?.data && (config.multiTenant || command.data.name !== "kichhoat")) body.push(command.data.toJSON());
  }
}

const rest = new REST().setToken(config.token);
if (config.multiTenant) {
  // Many servers: the commands are global (Discord can take up to an hour to show them everywhere)
  await rest.put(Routes.applicationCommands(config.clientId), { body });
  console.log(`Registered ${body.length} global commands.`);
} else {
  // One booking server: the commands appear at once
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
  console.log(`Registered ${body.length} commands on server ${config.guildId}.`);
}
