// Checks a real installation without changing anything: environment, Discord login, the server, the bot's permissions,
// registered commands, payOS credentials and the data folder. Run it after filling .env:  npm run smoke
import { existsSync } from "node:fs";
import { Client, GatewayIntentBits, PermissionFlagsBits as P } from "discord.js";
import { config } from "../src/config.js";
import { payosEnabled } from "../src/pay/payos.js";
import { getDb } from "../src/db.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const NEEDED = [
  ["ViewChannel", P.ViewChannel],
  ["SendMessages", P.SendMessages],
  ["EmbedLinks", P.EmbedLinks],
  ["ReadMessageHistory", P.ReadMessageHistory],
  ["ManageChannels", P.ManageChannels],
  ["ManageRoles", P.ManageRoles],
  ["AttachFiles", P.AttachFiles],
  ["Connect", P.Connect],
  ["Speak", P.Speak],
  ["Stream", P.Stream],
  ["MentionEveryone", P.MentionEveryone],
  ["CreateInstantInvite", P.CreateInstantInvite],
  ["AddReactions", P.AddReactions],
  ["CreatePublicThreads", P.CreatePublicThreads],
  ["CreatePrivateThreads", P.CreatePrivateThreads],
  ["SendMessagesInThreads", P.SendMessagesInThreads],
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });
try {
  await client.login(config.token);
  check("Discord login", true, client.user?.tag);
  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  check("the server is reachable by the bot", Boolean(guild), config.guildId);
  if (guild) {
    const me = await guild.members.fetchMe();
    for (const [name, flag] of NEEDED) check(`permission ${name}`, me.permissions.has(flag));
    check("no Administrator permission (it should not be needed)", !me.permissions.has(P.Administrator));
    const commands = await guild.commands.fetch();
    check("slash commands are registered", commands.size > 0, `${commands.size} commands (run npm run deploy-commands if 0)`);
    const roles = ["Khách", "Người chơi", "Trusted", "Khách quen", "Staff"].map((n) => [n, guild.roles.cache.find((r) => r.name === n)]);
    const top = me.roles.highest.position;
    for (const [name, role] of roles) {
      if (!role) console.log(`INFO role ${name} does not exist yet (run /setup)`);
      else if (name !== "Staff") check(`bot role is above ${name}`, top > role.position);
      else check("bot role is below Staff", top < role.position);
    }
  }
} catch (error) {
  check("Discord login", false, error.message);
} finally {
  await client.destroy();
}

check("payOS keys are set", payosEnabled(), payosEnabled() ? "" : "payments stay off until all three keys are set");
if (payosEnabled()) {
  try {
    const response = await fetch("https://api-merchant.payos.vn/v2/payment-requests/1", { headers: { "x-client-id": config.payos.clientId, "x-api-key": config.payos.apiKey }, signal: AbortSignal.timeout(15_000) });
    check("payOS accepts the keys", response.status !== 401 && response.status !== 403, `HTTP ${response.status}`);
  } catch (error) {
    check("payOS is reachable", false, error.message);
  }
}
getDb();
check("the database opens", true, config.dataDir === ":memory:" ? "memory" : `${config.dataDir}${existsSync(config.dataDir) ? "" : " (created)"}`);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
