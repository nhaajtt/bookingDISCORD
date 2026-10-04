import { config } from "../config.js";
import { recordAudit } from "../audit.js";
import { currentTenant, runInTenant } from "../db.js";
import { guildAccess } from "../tenancy.js";
import { split, tagAnswers } from "./dmtags.js";
import { langFor, localizeAnswers } from "../i18n.js";
import { now as clock } from "./clock.js";
import { limited } from "./limits.js";
import { failSoft, respond } from "./respond.js";
import { log } from "../log.js";

// One router for every interaction. Modules (files in src/commands and src/flows) export any of:
//   data, execute(interaction), autocomplete(interaction)       a slash command
//   buttons, modals, selects: { "<customId prefix>": handler }  components, matched by the longest prefix on ":" boundaries
// A handler gets (interaction, args) where args are the remaining parts of the custom id. Handlers check who is clicking.

function match(table, customId) {
  let best = null;
  for (const key of Object.keys(table ?? {})) {
    if ((customId === key || customId.startsWith(`${key}:`)) && (best === null || key.length > best.length)) best = key;
  }
  if (best === null) return null;
  const rest = customId.slice(best.length + 1);
  return { handler: table[best], args: rest ? rest.split(":") : [], key: best };
}

// Buttons the bot puts in DMs (reminders, rating prompts) arrive without a guild. Only these customer-facing ones are accepted there;
// the handlers look the server up themselves and check the person against the booking as always.
export const DM_PREFIXES = ["bk:rate", "bk:problem", "bk:cancel", "bk:new", "bk:again", "bk:tip", "cr:rate", "bk:wallet", "bk:paylink", "wt:book", "wt:leave", "sr:book", "sr:skip", "sr:stop"];
const allowedInDm = (interaction) => !interaction.guildId && DM_PREFIXES.some((p) => interaction.customId === p || interaction.customId?.startsWith(`${p}:`));

// What the audit trail stores about an interaction: the command with its short options, or the component id (never typed text)
function auditEntry(interaction) {
  if (interaction.isChatInputCommand?.()) {
    let sub = null;
    try {
      sub = interaction.options?.getSubcommand?.(false) ?? null;
    } catch {
      sub = null;
    }
    const options = (interaction.options?.data ?? []).flatMap((o) => (o.options ? o.options : [o])).filter((o) => o.value !== undefined && String(o.value).length <= 40);
    return { action: `/${interaction.commandName}${sub ? ` ${sub}` : ""}`, detail: options.map((o) => `${o.name}=${o.value}`).join(" ") || null };
  }
  return { action: interaction.customId, detail: null };
}

export function createRouter(modules) {
  const commands = new Map();
  const tables = { button: {}, modal: {}, select: {} };
  const auditedCommands = new Set();
  const auditedPrefixes = [];
  for (const mod of modules) {
    if (mod.data) commands.set(mod.data.name, mod);
    if (mod.audited && mod.data) auditedCommands.add(mod.data.name);
    if (mod.auditedPrefixes) auditedPrefixes.push(...mod.auditedPrefixes);
    Object.assign(tables.button, mod.buttons);
    Object.assign(tables.modal, mod.modals);
    Object.assign(tables.select, mod.selects);
  }

  const isAudited = (interaction) =>
    interaction.isChatInputCommand?.() ? auditedCommands.has(interaction.commandName) : auditedPrefixes.some((p) => interaction.customId === p || interaction.customId?.startsWith(`${p}:`));

  function trail(interaction) {
    if (!isAudited(interaction)) return;
    try {
      const entry = auditEntry(interaction);
      recordAudit({ actorId: interaction.user.id, ...entry }, clock());
    } catch (error) {
      log.error("audit.failed", { error });
    }
  }

  // Finds the server an interaction belongs to and runs it there. Single-server mode serves GUILD_ID only (a forged or stray interaction
  // from elsewhere is ignored). Multi-server mode runs it against that server's own data, and answers a server without a license
  // with the reason instead of doing anything; /kichhoat is the one command a server without a license may use.
  async function dispatch(interaction) {
    let guildId = interaction.guildId ?? null;
    if (!guildId) {
      if (config.multiTenant) {
        const tagged = split(interaction.customId);
        if (!tagged.guildId) return false;
        interaction.customId = tagged.customId;
        guildId = tagged.guildId;
      } else guildId = config.guildId;
      if (!allowedInDm(interaction)) return false;
    }
    if (config.multiTenant && interaction.commandName === "kichhoat") return run(interaction);
    const access = guildAccess(guildId, clock());
    if (!access.ok) {
      if (!config.multiTenant || interaction.isAutocomplete?.()) return false;
      try {
        await respond(interaction, access.reason);
      } catch (error) {
        log.error("license.deny_failed", { error });
      }
      return true;
    }
    if (!interaction.guildId && config.multiTenant) tagAnswers(interaction, guildId);
    return config.multiTenant ? runInTenant(guildId, () => run(interaction)) : run(interaction);
  }

  async function run(interaction) {
    // Private answers come out in the person's language (their choice, else what their Discord app uses)
    try {
      if (!config.multiTenant || currentTenant()) localizeAnswers(interaction, langFor(interaction.user?.id, interaction.locale));
    } catch (error) {
      log.error("i18n.failed", { error });
    }
    const label = interaction.commandName ?? interaction.customId ?? "interaction";
    try {
      if (interaction.isAutocomplete?.()) {
        await commands.get(interaction.commandName)?.autocomplete?.(interaction);
        return true;
      }
      const tooFast = limited(interaction.user.id, "any");
      if (tooFast) {
        await respond(interaction, tooFast);
        return true;
      }
      if (interaction.isChatInputCommand?.()) {
        await commands.get(interaction.commandName)?.execute(interaction);
        trail(interaction);
        return true;
      }
      const kind = interaction.isModalSubmit?.() ? "modal" : interaction.isStringSelectMenu?.() ? "select" : interaction.isButton?.() ? "button" : null;
      if (!kind) return false;
      const found = match(tables[kind], interaction.customId);
      if (!found) return false;
      await found.handler(interaction, found.args);
      trail(interaction);
      return true;
    } catch (error) {
      if (interaction.isAutocomplete?.()) {
        log.error("autocomplete.failed", { label, error });
        await interaction.respond?.([])?.catch?.(() => {});
        return true;
      }
      await failSoft(interaction, error, label);
      return true;
    }
  }

  return { commands, tables, dispatch };
}
