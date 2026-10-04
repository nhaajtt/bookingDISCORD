import { randomBytes } from "node:crypto";
import { getDb, transaction } from "../db.js";
import { fail } from "./errors.js";
import { walletBalance } from "./wallet.js";

// Gift cards. A customer buys one with money from their own wallet and gets a code; whoever enters the code first gets that amount
// in their wallet. The money only moves between wallets, so the owner's wallet liability does not change and nothing is owed to
// anybody by hand. A code is single use and cannot be redeemed by the person who bought it.

export const GIFT_MIN_VND = 20_000;
export const GIFT_MAX_VND = 5_000_000;
export const GIFT_STEP_VND = 1_000;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () => `GC-${Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("")}`;
export const normalizeGiftCode = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^GC/, "GC-");

// buyGiftCard(buyerId, amountVnd, now) -> { code, amountVnd, balance }
export function buyGiftCard(buyerId, amountVnd, now = Date.now()) {
  if (!Number.isInteger(amountVnd) || amountVnd % GIFT_STEP_VND || amountVnd < GIFT_MIN_VND || amountVnd > GIFT_MAX_VND) {
    fail("INVALID_INPUT", { message: `Thẻ quà tặng từ ${GIFT_MIN_VND.toLocaleString("vi-VN")} đến ${GIFT_MAX_VND.toLocaleString("vi-VN")} đ, chia hết cho ${GIFT_STEP_VND.toLocaleString("vi-VN")}.` });
  }
  return transaction(() => {
    const db = getDb();
    const balance = walletBalance(buyerId);
    if (balance < amountVnd) fail("WALLET_LOW", { balance });
    let code = makeCode();
    while (db.prepare("SELECT 1 FROM gift_cards WHERE code = ?").get(code)) code = makeCode();
    db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'SPEND', ?, ?)").run(buyerId, -amountVnd, `thẻ quà tặng ${code}`, now);
    db.prepare("INSERT INTO gift_cards (code, amount_vnd, buyer_id, created_at) VALUES (?, ?, ?, ?)").run(code, amountVnd, buyerId, now);
    return { code, amountVnd, balance: balance - amountVnd };
  });
}

// redeemGiftCard(userId, code, now) -> { amountVnd, balance }
export function redeemGiftCard(userId, code, now = Date.now()) {
  return transaction(() => {
    const db = getDb();
    const card = db.prepare("SELECT * FROM gift_cards WHERE code = ?").get(normalizeGiftCode(code));
    if (!card) fail("INVALID_INPUT", { message: "Mã thẻ quà tặng không đúng." });
    if (card.redeemed_at) fail("INVALID_INPUT", { message: "Thẻ quà tặng này đã được dùng rồi." });
    if (card.buyer_id === userId) fail("INVALID_INPUT", { message: "Bạn không thể tự nhận thẻ do chính mình mua, hãy tặng cho người khác." });
    const took = Number(db.prepare("UPDATE gift_cards SET redeemed_by = ?, redeemed_at = ? WHERE code = ? AND redeemed_at IS NULL").run(userId, now, card.code).changes);
    if (!took) fail("INVALID_INPUT", { message: "Thẻ quà tặng này đã được dùng rồi." });
    db.prepare("INSERT INTO wallet_tx (user_id, amount_vnd, kind, note, created_at) VALUES (?, ?, 'TOPUP', ?, ?)").run(userId, card.amount_vnd, `nhận thẻ quà tặng ${card.code}`, now);
    return { amountVnd: card.amount_vnd, balance: walletBalance(userId) };
  });
}

// The cards a person bought and have not been used yet, so they can find a code again
export const unusedGiftCards = (buyerId) => getDb().prepare("SELECT code, amount_vnd, created_at FROM gift_cards WHERE buyer_id = ? AND redeemed_at IS NULL ORDER BY created_at DESC").all(buyerId);
