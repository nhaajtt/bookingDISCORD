import { getDb } from "../db.js";

// Self-attestation that the person is 18 or older, stored once with the time it was given. It is a declaration, not a verification.

export const ADULT_KIND = "ADULT_18";
export const ATTEST_PHRASE = "TÔI ĐÃ ĐỦ 18 TUỔI";
// The same declaration in English, accepted for people who use the bot in English
export const ATTEST_PHRASE_EN = "I AM 18 OR OLDER";

const normalizePhrase = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

// True when the typed text is the confirmation phrase, ignoring case, accents and extra spaces
export function isAttestPhrase(text) {
  const typed = normalizePhrase(text);
  return typed === normalizePhrase(ATTEST_PHRASE) || typed === ATTEST_PHRASE_EN;
}

// Records the attestation. The first one wins, so asking again never moves the timestamp. Returns the stored row.
export function attest(userId, now = Date.now(), kind = ADULT_KIND) {
  getDb().prepare("INSERT OR IGNORE INTO attestations (user_id, kind, at) VALUES (?, ?, ?)").run(userId, kind, now);
  return getAttestation(userId);
}

export function getAttestation(userId) {
  const row = getDb().prepare("SELECT user_id, kind, at FROM attestations WHERE user_id = ?").get(userId);
  return row ? { userId: row.user_id, kind: row.kind, at: row.at } : null;
}

export const hasAttested = (userId) => getAttestation(userId)?.kind === ADULT_KIND;
