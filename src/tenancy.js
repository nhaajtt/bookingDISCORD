import { config } from "./config.js";
import { runInTenant } from "./db.js";
import { licenseStatus, licensedGuildIds } from "./license.js";
import { log } from "./log.js";

// Which server a piece of work belongs to.
//
// Single-server mode (the default): the bot serves exactly GUILD_ID and everything runs against the default database.
// Multi-server mode (MULTI_TENANT=true): every server is a tenant with its own database, settings, payment keys and license. Work for a
// tenant runs inside runInTenant(), which points getDb() at that tenant, so the domain code does not know the difference.

// Can this server be served? { ok, reason }. In single-server mode only GUILD_ID is; in multi-server mode a server needs a license
// (unless LICENSE_REQUIRED=false).
export function guildAccess(guildId, now = Date.now()) {
  if (!guildId) return { ok: false, reason: "no-guild" };
  if (!config.multiTenant) return guildId === config.guildId ? { ok: true } : { ok: false, reason: "other-server" };
  if (!config.licenseRequired) return { ok: true };
  const status = licenseStatus(guildId, now);
  return status.ok ? { ok: true, state: status.state, daysLeft: status.daysLeft } : { ok: false, reason: status.reason, state: status.state };
}

// Runs fn for work that arrived from a server (an interaction, a voice event, a web request). Returns undefined when the server is
// not served, so callers can tell "not for us" from a result.
export async function withGuild(guildId, fn) {
  if (!guildAccess(guildId).ok) return undefined;
  return config.multiTenant ? runInTenant(guildId, fn) : fn();
}

// The same for the case where the answer to an unlicensed server is a message, not silence: fn is run if allowed, otherwise
// onDenied(reason) is
export async function withGuildOr(guildId, fn, onDenied) {
  const access = guildAccess(guildId);
  if (!access.ok) return onDenied(access);
  return config.multiTenant ? runInTenant(guildId, fn) : fn();
}

let known = () => [];
// The bot's client tells the tenancy layer which servers it is in, so jobs only visit servers the bot can really reach
export function setGuildSource(fn) {
  known = fn;
}

export function activeGuildIds(now = Date.now()) {
  if (!config.multiTenant) return [config.guildId];
  const licensed = config.licenseRequired ? new Set(licensedGuildIds(now)) : null;
  return known().filter((id) => !licensed || licensed.has(id));
}

// Runs fn(guildId) once for every server this process serves (the jobs), each inside that server's data. One server failing does not
// stop the others; the first error is thrown once every server has had its turn.
export async function forEachGuild(fn) {
  const results = [];
  let failure = null;
  for (const guildId of activeGuildIds()) {
    try {
      results.push(config.multiTenant ? await runInTenant(guildId, () => fn(guildId)) : await fn(guildId));
    } catch (error) {
      log.error("tenant.run_failed", { guild: guildId, error });
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return results;
}

export { runInTenant };
