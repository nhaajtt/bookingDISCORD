import { getDb } from "./db.js";

// Tiny key-value store for bookkeeping that is not business data, such as "the daily digest of this date was posted"
export function kvGet(key) {
  return getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key)?.value ?? null;
}

export function kvSet(key, value) {
  getDb().prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}
