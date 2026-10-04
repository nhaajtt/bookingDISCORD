import { getDb, transaction } from "../db.js";
import { getSettings } from "../settings.js";
import { fail } from "./errors.js";
import { hasAttested } from "./attestations.js";
import { isBlacklisted } from "./strikes.js";
import { validateRate, limitsFrom } from "./pricing.js";
import { parseAvailability, setAvailability } from "./availability.js";
import { sanitizeText } from "./ratings.js";

// Player lifecycle: apply -> PENDING -> (staff) ACTIVE or REJECTED; ACTIVE <-> PAUSED by the player; SUSPENDED by strikes or staff.

const MAX_GAMES = 8;

function row(r) {
  if (!r) return null;
  return {
    userId: r.user_id,
    displayName: r.display_name,
    games: JSON.parse(r.games),
    rateVnd: r.rate_vnd,
    bio: r.bio,
    languages: r.languages,
    status: r.status,
    ratingSum: r.rating_sum,
    ratingCount: r.rating_count,
    average: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 100) / 100 : 0,
    completed: r.completed,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    profileMessageId: r.profile_message_id,
    photos: JSON.parse(r.photos || "[]"),
    voiceUrl: r.voice_url || "",
    leftAt: r.left_at ?? null,
  };
}

export function getPlayer(userId) {
  return row(getDb().prepare("SELECT * FROM players WHERE user_id = ?").get(userId));
}

// listPlayers({ status?, game? }) -> players, newest first
export function listPlayers({ status = null, game = null } = {}) {
  const rows = getDb()
    .prepare(status ? "SELECT * FROM players WHERE status = ? ORDER BY created_at DESC" : "SELECT * FROM players ORDER BY created_at DESC")
    .all(...(status ? [status] : []))
    .map(row);
  if (!game) return rows;
  const wanted = game.trim().toLowerCase();
  return rows.filter((p) => p.games.some((g) => g.toLowerCase() === wanted));
}

function cleanGames(games) {
  const list = (Array.isArray(games) ? games : String(games ?? "").split(/[,;\n]/))
    .map((g) => sanitizeText(g, 30))
    .filter(Boolean);
  const seen = new Set();
  const unique = list.filter((g) => !seen.has(g.toLowerCase()) && seen.add(g.toLowerCase()));
  if (!unique.length) fail("INVALID_INPUT", { message: "Chọn ít nhất một game hoặc chủ đề (ví dụ Liên Quân, Trò chuyện)." });
  if (unique.length > MAX_GAMES) fail("INVALID_INPUT", { message: `Tối đa ${MAX_GAMES} game hoặc chủ đề.` });
  return unique;
}

// applyAsPlayer({ userId, displayName, games, rateVnd, bio, languages }, now) -> player (status PENDING)
// Needs the 18+ attestation. A rejected applicant may apply again; players who are active, paused or suspended may not.
export function applyAsPlayer(input, now = Date.now(), settings = getSettings()) {
  const { userId } = input;
  if (isBlacklisted(userId)) fail("BLACKLISTED");
  if (!hasAttested(userId)) fail("NOT_ATTESTED");
  const displayName = sanitizeText(input.displayName, 32);
  if (!displayName) fail("INVALID_INPUT", { message: "Cần có tên hiển thị." });
  const games = cleanGames(input.games);
  const rateVnd = validateRate(input.rateVnd, limitsFrom(settings));
  const bio = sanitizeText(input.bio, 500);
  const languages = sanitizeText(input.languages, 60);

  return transaction(() => {
    const existing = getPlayer(userId);
    if (existing && ["ACTIVE", "PAUSED"].includes(existing.status)) fail("ALREADY_PLAYER");
    if (existing?.status === "SUSPENDED") fail("PLAYER_SUSPENDED");
    const db = getDb();
    if (existing) {
      db.prepare("UPDATE players SET display_name = ?, games = ?, rate_vnd = ?, bio = ?, languages = ?, status = 'PENDING', created_at = ? WHERE user_id = ?").run(
        displayName, JSON.stringify(games), rateVnd, bio, languages, now, userId,
      );
    } else {
      db.prepare("INSERT INTO players (user_id, display_name, games, rate_vnd, bio, languages, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)").run(
        userId, displayName, JSON.stringify(games), rateVnd, bio, languages, now,
      );
    }
    return getPlayer(userId);
  });
}

function move(userId, from, to, extra = "", params = []) {
  const changed = Number(getDb().prepare(`UPDATE players SET status = ?${extra} WHERE user_id = ? AND status IN (${from.map(() => "?").join(",")})`).run(to, ...params, userId, ...from).changes);
  if (!changed) {
    const current = getPlayer(userId);
    if (!current) fail("NOT_FOUND", { what: "player" });
    fail("ILLEGAL_TRANSITION", { status: current.status, action: to });
  }
  return getPlayer(userId);
}

// Staff approval: PENDING -> ACTIVE
export function approvePlayer(userId, staffId, now = Date.now()) {
  return move(userId, ["PENDING"], "ACTIVE", ", approved_at = ?", [now]);
}

// Staff rejection: PENDING -> REJECTED
export function rejectPlayer(userId, staffId, reason = "", now = Date.now()) {
  return move(userId, ["PENDING"], "REJECTED");
}

export const pausePlayer = (userId) => move(userId, ["ACTIVE"], "PAUSED");
export const resumePlayer = (userId) => {
  const player = move(userId, ["PAUSED"], "ACTIVE");
  getDb().prepare("UPDATE players SET left_at = NULL WHERE user_id = ?").run(userId);
  return { ...player, leftAt: null };
};

// A player who is no longer on the server cannot take bookings: an ACTIVE one is paused and the time is remembered. Returns true
// when this call did it. A paused or suspended player keeps that status, only the time is recorded.
export function markPlayerLeft(userId, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const player = getPlayer(userId);
    if (!player || player.leftAt !== null) return false;
    db.prepare("UPDATE players SET left_at = ?, status = CASE WHEN status = 'ACTIVE' THEN 'PAUSED' ELSE status END WHERE user_id = ?").run(now, userId);
    return true;
  });
}

// The player is back on the server: the time is cleared, the status stays paused until they resume themselves
export function clearPlayerLeft(userId) {
  return Number(getDb().prepare("UPDATE players SET left_at = NULL WHERE user_id = ? AND left_at IS NOT NULL").run(userId).changes) > 0;
}

const MAX_PHOTOS = 3;
const mediaUrl = (value, label) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    return fail("INVALID_INPUT", { message: `${label} không phải đường dẫn hợp lệ.` });
  }
  if (url.protocol !== "https:" || text.length > 300 || /discord\.(gg|com\/invite)/i.test(text)) fail("INVALID_INPUT", { message: `${label} phải là đường dẫn https, không phải link mời server.` });
  return url.toString();
};

// setMedia(userId, { photos?: [url], voiceUrl? }) -> player. Links only (hosted by the player on any image or audio site); empty clears.
export function setMedia(userId, { photos, voiceUrl }) {
  const current = getPlayer(userId);
  if (!current) fail("NOT_FOUND", { what: "player" });
  const nextPhotos = photos === undefined ? current.photos : photos.map((p, i) => mediaUrl(p, `Ảnh ${i + 1}`)).filter(Boolean).slice(0, MAX_PHOTOS);
  const nextVoice = voiceUrl === undefined ? current.voiceUrl : mediaUrl(voiceUrl, "Link giọng nói");
  getDb().prepare("UPDATE players SET photos = ?, voice_url = ? WHERE user_id = ?").run(JSON.stringify(nextPhotos), nextVoice, userId);
  return getPlayer(userId);
}

// Staff suspension (strikes suspend through strikes.addStrike). Lifting goes through strikes.liftSuspension.
export const suspendPlayer = (userId) => move(userId, ["ACTIVE", "PAUSED", "PENDING"], "SUSPENDED");

// updateProfile(userId, { displayName?, games?, rateVnd?, bio?, languages? })
export function updateProfile(userId, patch, settings = getSettings()) {
  const current = getPlayer(userId);
  if (!current) fail("NOT_FOUND", { what: "player" });
  const next = {
    displayName: patch.displayName === undefined ? current.displayName : sanitizeText(patch.displayName, 32) || current.displayName,
    games: patch.games === undefined ? current.games : cleanGames(patch.games),
    rateVnd: patch.rateVnd === undefined ? current.rateVnd : validateRate(patch.rateVnd, limitsFrom(settings)),
    bio: patch.bio === undefined ? current.bio : sanitizeText(patch.bio, 500),
    languages: patch.languages === undefined ? current.languages : sanitizeText(patch.languages, 60),
  };
  getDb().prepare("UPDATE players SET display_name = ?, games = ?, rate_vnd = ?, bio = ?, languages = ? WHERE user_id = ?").run(
    next.displayName, JSON.stringify(next.games), next.rateVnd, next.bio, next.languages, userId,
  );
  return getPlayer(userId);
}

export function setProfileMessage(userId, messageId) {
  getDb().prepare("UPDATE players SET profile_message_id = ? WHERE user_id = ?").run(messageId, userId);
}

// setAvailabilityText(userId, "T2 19:00-23:00; CN 09:00-12:00") -> { ok, slots, errors }; stores only when the text is fully valid
export function setAvailabilityText(userId, text) {
  if (!getPlayer(userId)) fail("NOT_FOUND", { what: "player" });
  const parsed = parseAvailability(text);
  if (parsed.ok) setAvailability(userId, parsed.slots);
  return parsed;
}
