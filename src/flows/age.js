import { ATTEST_PHRASE, attest, hasAttested, isAttestPhrase } from "../domain/attestations.js";
import { isBlacklisted } from "../domain/strikes.js";
import { DomainError } from "../domain/errors.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { modal, rawField } from "../discord/modals.js";
import { defer, respond } from "../discord/respond.js";
import { grantRole } from "../discord/roles.js";
import { log } from "../log.js";

// The 18+ gate. The button opens a modal where the person types the confirmation phrase; the right phrase records the attestation
// and grants the verified role. It is a declaration, not a verification, and the rules say so.

export const WRONG_PHRASE = `Câu xác nhận chưa đúng. Hãy gõ: ${ATTEST_PHRASE}`;
export const VERIFIED_TEXT = "Đã xác nhận. Bạn có thể xem các kênh đặt lịch rồi nhé. Server này chỉ dành cho người từ 18 tuổi trở lên và nội dung lành mạnh.";

async function open(interaction) {
  if (isBlacklisted(interaction.user.id)) throw new DomainError("BLACKLISTED");
  const tooMany = limited(interaction.user.id, "attest");
  if (tooMany) return respond(interaction, tooMany);
  if (hasAttested(interaction.user.id)) {
    // Already confirmed: make sure the role is there (it may have been removed by hand) and say so
    await defer(interaction);
    await grantRole(interaction.guild, interaction.user.id, "verified", { member: interaction.member });
    return respond(interaction, "Bạn đã xác nhận rồi. " + VERIFIED_TEXT);
  }
  return interaction.showModal(modal("age:submit", "Xác nhận đủ 18 tuổi", [{ id: "phrase", label: `Gõ đúng câu: ${ATTEST_PHRASE}`, max: 40, placeholder: ATTEST_PHRASE }]));
}

async function submit(interaction) {
  await defer(interaction);
  const userId = interaction.user.id;
  if (isBlacklisted(userId)) throw new DomainError("BLACKLISTED");
  const tooMany = limited(userId, "attest");
  if (tooMany) return respond(interaction, tooMany);
  if (!isAttestPhrase(rawField(interaction, "phrase"))) return respond(interaction, WRONG_PHRASE);
  attest(userId, now());
  const granted = await grantRole(interaction.guild, userId, "verified", { member: interaction.member });
  if (!granted.ok) log.error("role.verified_not_granted", { user: userId, reason: granted.reason });
  return respond(interaction, VERIFIED_TEXT);
}

export default {
  buttons: { "age:open": open },
  modals: { "age:submit": submit },
};
