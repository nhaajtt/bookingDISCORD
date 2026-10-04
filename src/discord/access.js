import { hasAttested } from "../domain/attestations.js";
import { isBlacklisted } from "../domain/strikes.js";
import { getPlayer } from "../domain/players.js";
import { DomainError } from "../domain/errors.js";
import { getSettings } from "../settings.js";
import { NO_PERMISSION, isOwner, isStaff } from "./permissions.js";

// One gate for every handler. Returns the refusal text, or null when the person may go on.
//   user    not blacklisted and has confirmed 18+
//   player  user, and has a player record that is not pending or rejected
//   staff   staff role or owner
//   owner   Administrator or OWNER_IDS

const pointer = (settings) => (settings.channels.ageGateChannelId ? `<#${settings.channels.ageGateChannelId}>` : "kênh xác nhận 18+");

export function gate(interaction, level = "user") {
  const userId = interaction.user.id;
  if (level === "owner") return isOwner(interaction.member, userId) ? null : NO_PERMISSION;
  if (level === "staff") return isStaff(interaction.member, userId) ? null : NO_PERMISSION;
  if (isBlacklisted(userId)) return new DomainError("BLACKLISTED").message;
  if (!hasAttested(userId)) return `${new DomainError("NOT_ATTESTED").message} Hãy bấm nút ở ${pointer(getSettings())}.`;
  if (level === "player") {
    const player = getPlayer(userId);
    if (!player || ["PENDING", "REJECTED"].includes(player.status)) return "Chỉ player đã được duyệt mới dùng được chức năng này.";
  }
  return null;
}
