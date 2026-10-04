import { getDb } from "../db.js";
import { fail } from "./errors.js";
import { sanitizeText } from "./ratings.js";

// Where a person wants to receive money: a player's payouts, a customer's refunds. The owner still sends the transfer by hand;
// this only saves them from asking, and builds a VietQR image with the amount and a note already filled in.

// Napas bank codes (BIN) of the common Vietnamese banks, with the names people type
export const BANKS = [
  ["Vietcombank", "970436", ["vcb", "vietcombank"]],
  ["VietinBank", "970415", ["ctg", "vietinbank", "viettinbank"]],
  ["BIDV", "970418", ["bidv"]],
  ["Agribank", "970405", ["agribank", "vbard"]],
  ["Techcombank", "970407", ["tcb", "techcombank"]],
  ["MB Bank", "970422", ["mb", "mbbank", "mb bank", "quan doi"]],
  ["ACB", "970416", ["acb"]],
  ["VPBank", "970432", ["vpb", "vpbank"]],
  ["TPBank", "970423", ["tpb", "tpbank"]],
  ["Sacombank", "970403", ["stb", "sacombank"]],
  ["HDBank", "970437", ["hdb", "hdbank"]],
  ["VIB", "970441", ["vib"]],
  ["SHB", "970443", ["shb"]],
  ["OCB", "970448", ["ocb"]],
  ["MSB", "970426", ["msb", "maritime", "maritimebank"]],
  ["SeABank", "970440", ["seab", "seabank"]],
  ["LPBank", "970449", ["lpb", "lpbank", "lienvietpostbank"]],
  ["Eximbank", "970431", ["eib", "eximbank"]],
  ["SCB", "970429", ["scb"]],
  ["Nam A Bank", "970428", ["nab", "nam a", "namabank"]],
  ["Bac A Bank", "970409", ["bab", "bac a", "bacabank"]],
  ["ABBank", "970425", ["abb", "abbank"]],
  ["PVcomBank", "970412", ["pvcb", "pvcombank"]],
  ["Bao Viet Bank", "970438", ["bvb", "baoviet"]],
  ["VietBank", "970433", ["vietbank"]],
  ["Kienlongbank", "970452", ["klb", "kienlongbank"]],
  ["NCB", "970419", ["ncb"]],
  ["DongA Bank", "970406", ["dab", "donga", "dong a"]],
  ["Saigonbank", "970400", ["sgicb", "saigonbank"]],
  ["PGBank", "970430", ["pgb", "pgbank"]],
  ["VietABank", "970427", ["vab", "vietabank"]],
  ["BVBank", "970454", ["bvbank", "ban viet"]],
  ["Woori Bank", "970457", ["woori"]],
  ["Shinhan Bank", "970424", ["shinhan"]],
  ["Cake", "546034", ["cake"]],
  ["Ubank", "546035", ["ubank"]],
  ["Timo", "963388", ["timo"]],
  ["Viettel Money", "971005", ["viettel money", "viettelmoney"]],
  ["VNPT Money", "971011", ["vnpt money", "vnptmoney"]],
];

const plain = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// "vcb", "Vietcombank" or a six digit BIN -> { name, bin } or null
export function findBank(input) {
  const text = plain(input);
  if (!text) return null;
  if (/^\d{6}$/.test(text)) {
    const known = BANKS.find(([, bin]) => bin === text);
    return { name: known ? known[0] : `Ngân hàng ${text}`, bin: text };
  }
  const hit = BANKS.find(([name, , aliases]) => plain(name) === text || aliases.some((a) => plain(a) === text));
  return hit ? { name: hit[0], bin: hit[1] } : null;
}

export const getBank = (userId) => getDb().prepare("SELECT * FROM bank_accounts WHERE user_id = ?").get(userId) ?? null;

// setBank(userId, { bank, accountNo, accountName }, now) -> the stored row. Holder names are kept in capitals without accents, as banks print them.
export function setBank(userId, { bank, accountNo, accountName }, now = Date.now()) {
  const found = findBank(bank);
  if (!found) fail("INVALID_INPUT", { message: "Không nhận ra ngân hàng. Gõ tên như Vietcombank, MB, ACB, Techcombank, hoặc mã 6 số của ngân hàng." });
  const number = String(accountNo ?? "").replace(/[\s.-]/g, "");
  if (!/^\d{6,19}$/.test(number)) fail("INVALID_INPUT", { message: "Số tài khoản chỉ gồm 6 đến 19 chữ số." });
  const holder = plain(sanitizeText(accountName, 50)).toUpperCase();
  if (holder.length < 2) fail("INVALID_INPUT", { message: "Cần tên chủ tài khoản (viết hoa, không dấu, như trên thẻ)." });
  getDb()
    .prepare(
      "INSERT INTO bank_accounts (user_id, bank_bin, bank_name, account_no, account_name, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET bank_bin = excluded.bank_bin, bank_name = excluded.bank_name, account_no = excluded.account_no, account_name = excluded.account_name, updated_at = excluded.updated_at",
    )
    .run(userId, found.bin, found.name, number, holder, now);
  return getBank(userId);
}

export const removeBank = (userId) => Number(getDb().prepare("DELETE FROM bank_accounts WHERE user_id = ?").run(userId).changes) > 0;

// One short line for the owner: "Vietcombank 0123456789 NGUYEN VAN A"
export const bankLine = (bank) => (bank ? `${bank.bank_name} ${bank.account_no} ${bank.account_name}` : "chưa có tài khoản");

// The transfer note: plain ASCII and short, so every banking app accepts it
export const transferNote = (row) => (row.kind === "REFUND" ? `HOAN LICH ${row.booking_id}` : `TRA LICH ${row.booking_id}`);

// A VietQR image the owner can scan: the bank, account, amount and note are already in the code
export function vietQrUrl(bank, amountVnd, note) {
  const q = new URLSearchParams({ amount: String(Math.round(amountVnd)), addInfo: note, accountName: bank.account_name });
  return `https://img.vietqr.io/image/${bank.bank_bin}-${bank.account_no}-compact2.png?${q.toString()}`;
}

export const BANK_HINT = "Hãy lưu số tài khoản nhận tiền bằng lệnh /nganhang để chủ server chuyển nhanh hơn.";
export const bankHint = (userId) => (getBank(userId) ? "" : ` ${BANK_HINT}`);
