import { getSettings } from "../settings.js";
import { dangerousPermissionsOf } from "./permissions.js";
import { fetchMember } from "./guild.js";
import { log } from "../log.js";

// The bot grants and removes exactly four roles, each only from facts in the database. It refuses every other role and every role
// that carries a powerful permission, even when one is configured by mistake.
export const GRANTABLE = Object.freeze({
  verified: "verifiedRoleId",
  player: "playerRoleId",
  trusted: "trustedPlayerRoleId",
  regular: "regularCustomerRoleId",
});

// Resolves a role kind to a role the bot may touch, or explains why not
function resolve(guild, kind, settings) {
  const key = GRANTABLE[kind];
  if (!key) return { ok: false, reason: "not-allowed" };
  const roleId = settings.roles[key];
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  if (!role) return { ok: false, reason: "missing" };
  const dangerous = dangerousPermissionsOf(role);
  if (dangerous.length) return { ok: false, reason: `dangerous: ${dangerous.join(", ")}` };
  return { ok: true, role };
}

async function change(guild, userId, kind, add, { member = null, reason = "booking bot" } = {}) {
  const found = resolve(guild, kind, getSettings());
  if (!found.ok) return found;
  const target = member ?? (await fetchMember(guild, userId));
  if (!target) return { ok: false, reason: "no-member" };
  try {
    if (add) await target.roles.add(found.role.id, reason);
    else await target.roles.remove(found.role.id, reason);
    return { ok: true };
  } catch (error) {
    log.error("role.change_failed", { action: add ? "grant" : "remove", kind, user: userId, error });
    return { ok: false, reason: "failed" };
  }
}

export const grantRole = (guild, userId, kind, options) => change(guild, userId, kind, true, options);
export const revokeRole = (guild, userId, kind, options) => change(guild, userId, kind, false, options);

// Whether a member holds the bot-managed role of this kind
export function holdsRole(guild, member, kind) {
  const roleId = getSettings().roles[GRANTABLE[kind]];
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}
