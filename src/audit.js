import { getDb } from "./db.js";

// The audit trail: who did which staff or owner action, and when. Written by the router for every command and component that
// belongs to a module marked as audited, so no handler has to remember to log. Rows are only ever added.

const clip = (value, max) => String(value ?? "").slice(0, max);

export function recordAudit({ actorId, action, target = null, detail = null }, now = Date.now()) {
  getDb().prepare("INSERT INTO audit_log (at, actor_id, action, target, detail) VALUES (?, ?, ?, ?, ?)").run(now, actorId ?? null, clip(action, 80), target === null ? null : clip(target, 80), detail === null ? null : clip(detail, 400));
}

// listAudit({ limit?, actorId?, since? }) -> newest first
export function listAudit({ limit = 25, actorId = null, since = null } = {}) {
  const where = [];
  const params = [];
  if (actorId) (where.push("actor_id = ?"), params.push(actorId));
  if (since !== null) (where.push("at >= ?"), params.push(since));
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
  return getDb().prepare(sql).all(...params, Math.min(200, Math.max(1, limit)));
}

export const countAudit = () => getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
