import { PermissionFlagsBits } from "discord.js";
import { config } from "../config.js";
import { getSettings } from "../settings.js";

// Who is who. Owners: Discord Administrator or a user ID in OWNER_IDS. Staff: the staff role, plus every owner.
// Every handler of a staff or owner action calls these first, buttons and modals included: a hidden command is not a lock.

export function memberHasRole(member, roleId) {
  if (!member || !roleId) return false;
  const roles = member.roles;
  if (Array.isArray(roles)) return roles.includes(roleId);
  return Boolean(roles?.cache?.has(roleId));
}

export function isOwner(member, userId = member?.user?.id ?? member?.id) {
  // OWNER_IDS belong to the one server of a single-server install; in multi-server mode each server's owner is its Administrator
  if (userId && !config.multiTenant && config.ownerIds.includes(userId)) return true;
  return Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

export function isStaff(member, userId = member?.user?.id ?? member?.id, settings = getSettings()) {
  return isOwner(member, userId) || memberHasRole(member, settings.roles.staffRoleId);
}

export const NO_PERMISSION = "Bạn không có quyền dùng chức năng này.";

// Permissions that a role handed out by the bot must never carry
export const DANGEROUS_PERMISSIONS = [
  ["Administrator", PermissionFlagsBits.Administrator],
  ["ManageGuild", PermissionFlagsBits.ManageGuild],
  ["ManageRoles", PermissionFlagsBits.ManageRoles],
  ["ManageChannels", PermissionFlagsBits.ManageChannels],
  ["ManageMessages", PermissionFlagsBits.ManageMessages],
  ["KickMembers", PermissionFlagsBits.KickMembers],
  ["BanMembers", PermissionFlagsBits.BanMembers],
  ["ModerateMembers", PermissionFlagsBits.ModerateMembers],
  ["MentionEveryone", PermissionFlagsBits.MentionEveryone],
];

// Names of the dangerous permissions the role has (empty when it is safe to hand out)
export function dangerousPermissionsOf(role) {
  return DANGEROUS_PERMISSIONS.filter(([, flag]) => role?.permissions?.has?.(flag)).map(([name]) => name);
}
