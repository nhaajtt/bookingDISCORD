import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

// One SQLite file per tenant. Single-server installs only ever use the "default" tenant (data/thauxbooking.db). In multi-server
// mode every interaction and job runs inside runInTenant(guildId, fn) and getDb() follows it, so the domain code stays unaware.
const tenantStore = new AsyncLocalStorage();
const states = new Map();
export const currentTenant = () => tenantStore.getStore() ?? null;
let outsideAllowed = false;
// For the few places that really work across servers without a database of their own (none today); tests use it to set up
export const withoutTenant = (fn) => {
  outsideAllowed = true;
  try {
    return fn();
  } finally {
    outsideAllowed = false;
  }
};
export const runInTenant = (guildId, fn) => {
  if (!/^\d{17,20}$/.test(String(guildId))) throw new Error("not a server id");
  return tenantStore.run(String(guildId), fn);
};
export const openTenants = () => [...states.keys()];

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  games TEXT NOT NULL DEFAULT '[]',
  rate_vnd INTEGER NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  languages TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','PAUSED','SUSPENDED','REJECTED')),
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  profile_message_id TEXT
);
CREATE INDEX IF NOT EXISTS players_status ON players (status);
CREATE TABLE IF NOT EXISTS availability (
  player_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  CHECK (start_min < end_min)
);
CREATE INDEX IF NOT EXISTS availability_player ON availability (player_id);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  game TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  price_vnd INTEGER NOT NULL CHECK (price_vnd >= 0),
  fee_vnd INTEGER NOT NULL CHECK (fee_vnd >= 0 AND fee_vnd <= price_vnd),
  status TEXT NOT NULL CHECK (status IN ('AWAITING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW_PLAYER','NO_SHOW_CUSTOMER','DISPUTED','EXPIRED')),
  order_code INTEGER,
  text_channel_id TEXT,
  voice_channel_id TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  rating INTEGER,
  review TEXT,
  cancelled_by TEXT,
  refund_due_vnd INTEGER NOT NULL DEFAULT 0,
  reminders_sent TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS bookings_player ON bookings (player_id, start_at);
CREATE INDEX IF NOT EXISTS bookings_customer ON bookings (customer_id, start_at);
CREATE INDEX IF NOT EXISTS bookings_status ON bookings (status);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PLAYER_PAYOUT','REFUND','FEE_INCOME')),
  party_user_id TEXT,
  amount_vnd INTEGER NOT NULL CHECK (amount_vnd >= 0),
  status TEXT NOT NULL CHECK (status IN ('OWED','PAID')),
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  paid_by TEXT,
  note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_once ON ledger (booking_id, kind);
CREATE INDEX IF NOT EXISTS ledger_status ON ledger (status, kind);
CREATE INDEX IF NOT EXISTS ledger_party ON ledger (party_user_id, status);
CREATE TABLE IF NOT EXISTS strikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  booking_id INTEGER,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cleared_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS strikes_once ON strikes (user_id, booking_id, reason);
CREATE INDEX IF NOT EXISTS strikes_user ON strikes (user_id, created_at);
CREATE TABLE IF NOT EXISTS blacklist (
  user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  by_user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  opener_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  resolution TEXT,
  resolved_by TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_open ON disputes (booking_id) WHERE status = 'OPEN';
CREATE TABLE IF NOT EXISTS attestations (
  user_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  order_code INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','CANCELLED','EXPIRED','FAILED')),
  checkout_url TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS orders_booking ON orders (booking_id);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log (actor_id, at);
CREATE TABLE IF NOT EXISTS bank_accounts (
  user_id TEXT PRIMARY KEY,
  bank_bin TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_no TEXT NOT NULL,
  account_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('PERCENT','FIXED')),
  value INTEGER NOT NULL CHECK (value > 0),
  max_uses INTEGER,
  used INTEGER NOT NULL DEFAULT 0,
  per_user INTEGER NOT NULL DEFAULT 1,
  min_price_vnd INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coupon_uses (
  booking_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  user_id TEXT NOT NULL,
  discount_vnd INTEGER NOT NULL,
  at INTEGER NOT NULL,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS coupon_uses_code ON coupon_uses (code, user_id);
CREATE TABLE IF NOT EXISTS wallet_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount_vnd INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('TOPUP','BONUS','SPEND','REFUND','POINTS','ADJUST')),
  booking_id INTEGER,
  order_code INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wallet_user ON wallet_tx (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_once_booking ON wallet_tx (kind, booking_id) WHERE booking_id IS NOT NULL AND kind IN ('SPEND','REFUND');
CREATE UNIQUE INDEX IF NOT EXISTS wallet_once_order ON wallet_tx (kind, order_code) WHERE order_code IS NOT NULL AND kind IN ('TOPUP','BONUS');
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  game TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  duration_min INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  notified_at INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS waitlist_player ON waitlist (player_id, start_at);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_once ON waitlist (customer_id, player_id, start_at, duration_min) WHERE done_at IS NULL;
CREATE TABLE IF NOT EXISTS player_games (
  player_id TEXT NOT NULL,
  game TEXT NOT NULL,
  rate_vnd INTEGER NOT NULL CHECK (rate_vnd > 0),
  PRIMARY KEY (player_id, game)
);
CREATE TABLE IF NOT EXISTS customer_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  note TEXT NOT NULL,
  by_user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_notes_user ON customer_notes (user_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_hash TEXT NOT NULL,
  about_user_id TEXT,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);
CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  game TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  weekday INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY,
  lang TEXT NOT NULL CHECK (lang IN ('vi','en')),
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS loyalty (
  user_id TEXT PRIMARY KEY,
  redeemed_points INTEGER NOT NULL DEFAULT 0
);
`;

// Columns added after the first release. Each is added once, so an old database file is upgraded in place when it is opened.
const COLUMNS = [
  ["bookings", "list_price_vnd", "INTEGER"],
  ["bookings", "discount_vnd", "INTEGER NOT NULL DEFAULT 0"],
  ["bookings", "coupon_code", "TEXT"],
  ["bookings", "paid_with", "TEXT"],
  ["bookings", "series_id", "INTEGER"],
  ["bookings", "extended_min", "INTEGER NOT NULL DEFAULT 0"],
  ["players", "photos", "TEXT NOT NULL DEFAULT '[]'"],
  ["players", "voice_url", "TEXT NOT NULL DEFAULT ''"],
  ["players", "left_at", "INTEGER"],
  ["orders", "kind", "TEXT NOT NULL DEFAULT 'BOOKING'"],
  ["orders", "provider", "TEXT NOT NULL DEFAULT 'payos'"],
  ["orders", "external_id", "TEXT"],
  ["orders", "extra_min", "INTEGER NOT NULL DEFAULT 0"],
  ["orders", "extra_fee", "INTEGER NOT NULL DEFAULT 0"],
  ["orders", "bonus_vnd", "INTEGER NOT NULL DEFAULT 0"],
  ["series", "next_at", "INTEGER NOT NULL DEFAULT 0"],
];

function ensureColumns(handle) {
  for (const [table, column, ddl] of COLUMNS) {
    const has = handle.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function fileFor(key) {
  if (key !== "default" && !/^\d{17,20}$/.test(key)) throw new Error("not a server id");
  if (config.dataDir === ":memory:") return ":memory:";
  if (key === "default") {
    mkdirSync(config.dataDir, { recursive: true });
    return path.join(config.dataDir, "thauxbooking.db");
  }
  // A tenant is a Discord server id, nothing else, so no request can make up a file name
  if (!/^\d{17,20}$/.test(key)) throw new Error("not a server id");
  const dir = path.join(config.dataDir, "tenants");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key}.db`);
}

function state() {
  // In many-server mode every piece of work belongs to a server. Opening the default database would mix servers up, so it is refused
  // loudly instead (a bug of that kind must never go unnoticed).
  if (config.multiTenant && !tenantStore.getStore() && !outsideAllowed) throw new Error("A database was opened outside any server in many-server mode");
  const key = currentTenant() ?? "default";
  let s = states.get(key);
  if (!s) {
    const handle = new DatabaseSync(fileFor(key));
    handle.exec("PRAGMA journal_mode = WAL;");
    handle.exec(schema);
    ensureColumns(handle);
    s = { db: handle, depth: 0 };
    states.set(key, s);
  }
  return s;
}

export const getDb = () => state().db;

// Closes every open database (the tests reopen with a fresh one)
export function closeDb() {
  for (const s of states.values()) s.db.close();
  states.clear();
}

// Runs fn inside one database transaction and rolls everything back if it throws. Nested calls become savepoints, so a domain
// function can be used on its own or as one step of a bigger one. fn must be synchronous.
export function transaction(fn) {
  const s = state();
  const handle = s.db;
  if (s.depth === 0) {
    handle.exec("BEGIN IMMEDIATE");
    s.depth = 1;
    try {
      const result = fn();
      handle.exec("COMMIT");
      return result;
    } catch (error) {
      handle.exec("ROLLBACK");
      throw error;
    } finally {
      s.depth = 0;
    }
  }
  const name = `sp${s.depth}`;
  s.depth += 1;
  handle.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    handle.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    handle.exec(`ROLLBACK TO ${name}`);
    handle.exec(`RELEASE ${name}`);
    throw error;
  } finally {
    s.depth -= 1;
  }
}
