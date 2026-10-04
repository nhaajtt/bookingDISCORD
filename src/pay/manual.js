import { getBank, vietQrUrl } from "../domain/bank.js";
import { formatVnd } from "../domain/pricing.js";
import { describeOrder, getOrder } from "./orders.js";

// Payment by bank transfer to the owner's own account, with no gateway in between. The customer gets a VietQR image with the amount
// and a short note already filled in, transfers, and the owner presses "received" once the money is in the account (or it is
// matched automatically by a gateway later). Until then the order stays pending, so nothing is confirmed on the customer's word.

// The owner's receiving account is kept in the bank table under this reserved id (no Discord user has it)
export const RECEIVER = "owner";

export const receivingAccount = () => getBank(RECEIVER);
export const manualEnabled = () => Boolean(receivingAccount());

// Gateway entry points (see gateway.js)
export async function createManualLink(order) {
  const bank = receivingAccount();
  if (!bank) throw new Error("no receiving account");
  return { checkoutUrl: vietQrUrl(bank, order.amount, order.description), externalId: null };
}

// A transfer cannot be read from here: the order stays pending until the owner confirms it
export const manualPayment = async () => ({ status: "PENDING", paid: false, closed: false, amount: 0, amountPaid: 0 });

// The words that tell a customer exactly what to transfer
export function transferInstructions(amountVnd, note) {
  const bank = receivingAccount();
  if (!bank) return "";
  return `Chuyển khoản ${formatVnd(amountVnd)} đến ${bank.bank_name} ${bank.account_no} (${bank.account_name}), nội dung: ${note}. Giữ nguyên số tiền và nội dung. Chủ server xác nhận khi nhận được tiền.`;
}

// Everything a page needs to show a transfer: where to send it, how much, the note, and the QR image. Null when the order is not a transfer.
export function manualDetails(orderCode) {
  const order = orderCode ? getOrder(orderCode) : null;
  const bank = receivingAccount();
  if (!order || order.provider !== "manual" || !bank) return null;
  const note = describeOrder(order.order_code, order.kind);
  return { orderCode: order.order_code, bankName: bank.bank_name, accountNo: bank.account_no, accountName: bank.account_name, amountVnd: order.amount, note, qrUrl: vietQrUrl(bank, order.amount, note) };
}
