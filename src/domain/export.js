import { getDb } from "../db.js";
import { getSettings } from "../settings.js";
import { formatLocal } from "./time.js";

// CSV for the owner's accountant. Cells are quoted when needed, and a cell that starts with = + - or @ gets a leading apostrophe
// so a spreadsheet never runs it as a formula.

const cell = (value) => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csv = (header, rows) => `﻿${[header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;

// ledgerCsv({ status?: "OWED" | "PAID", from?, to? }) -> text. One line per ledger row with who gets the money and their bank.
export function ledgerCsv({ status = null, from = null, to = null, settings = getSettings() } = {}) {
  const where = ["l.kind != 'FEE_INCOME'"];
  const params = [];
  if (status) (where.push("l.status = ?"), params.push(status));
  if (from !== null) (where.push("l.created_at >= ?"), params.push(from));
  if (to !== null) (where.push("l.created_at < ?"), params.push(to));
  const rows = getDb()
    .prepare(
      `SELECT l.*, b.game, b.start_at, a.bank_name, a.account_no, a.account_name
       FROM ledger l JOIN bookings b ON b.id = l.booking_id LEFT JOIN bank_accounts a ON a.user_id = l.party_user_id
       WHERE ${where.join(" AND ")} ORDER BY l.id`,
    )
    .all(...params);
  const zone = settings.timezone;
  return csv(
    ["id", "booking", "loai", "nguoi_nhan", "so_tien_vnd", "trang_thai", "ngan_hang", "so_tai_khoan", "chu_tai_khoan", "noi_dung_chuyen", "tao_luc", "tra_luc", "tra_boi", "ghi_chu"],
    rows.map((r) => [
      r.id,
      r.booking_id,
      r.kind === "REFUND" ? "hoan_tien" : r.kind === "TIP" ? "tip_player" : "tra_player",
      r.party_user_id,
      r.amount_vnd,
      r.status === "PAID" ? "da_chuyen" : "can_chuyen",
      r.bank_name,
      r.account_no,
      r.account_name,
      `${r.kind === "REFUND" ? "HOAN" : r.kind === "TIP" ? "TIP" : "TRA"} LICH ${r.booking_id}`,
      formatLocal(r.created_at, zone),
      r.paid_at ? formatLocal(r.paid_at, zone) : "",
      r.paid_by,
      r.note,
    ]),
  );
}

// bookingsCsv({ from?, to? }) -> text, for the revenue report
export function bookingsCsv({ from = null, to = null, settings = getSettings() } = {}) {
  const where = [];
  const params = [];
  if (from !== null) (where.push("start_at >= ?"), params.push(from));
  if (to !== null) (where.push("start_at < ?"), params.push(to));
  const rows = getDb().prepare(`SELECT * FROM bookings ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`).all(...params);
  return csv(
    ["id", "khach", "player", "game", "bat_dau", "phut", "gia_vnd", "phi_vnd", "giam_vnd", "ma_giam", "trang_thai", "hoan_vnd"],
    rows.map((b) => [b.id, b.customer_id, b.player_id, b.game, formatLocal(b.start_at, settings.timezone), b.duration_min, b.price_vnd, b.fee_vnd, b.discount_vnd, b.coupon_code, b.status, b.refund_due_vnd]),
  );
}
