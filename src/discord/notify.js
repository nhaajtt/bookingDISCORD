import { getPlayer } from "../domain/players.js";
import { bankHint } from "../domain/bank.js";
import { formatLocal } from "../domain/time.js";
import { formatVnd } from "../domain/pricing.js";
import { getSettings } from "../settings.js";
import { alert } from "../alerts.js";
import { getGuild, mention, postLog, sendDm } from "./guild.js";
import { durationText } from "./text.js";
import { audit, moneyLog } from "./moderation.js";

// What the payments job tells the Discord side (client.notifyBooking). Every send is best effort: a closed DM falls back to the log
// channel with a mention, and nothing here can undo the payment that was already recorded.

export async function announce(client, event) {
  const guild = await getGuild(client);
  const { booking, order } = event;

  if (event.kind === "auto_refund") {
    const amount = formatVnd(event.row.amount_vnd);
    await sendDm(client, event.row.party_user_id, `Đã hoàn ${amount} về thẻ bạn đã dùng thanh toán (lịch #${event.row.booking_id}). Tiền về tài khoản trong vài ngày làm việc tuỳ ngân hàng.`);
    if (guild) await moneyLog(guild, `Hoàn tự động ${amount} cho ${mention(event.row.party_user_id)}, lịch #${event.row.booking_id}.`);
    return;
  }

  if (event.kind === "partial") {
    const what = booking ? `đơn của lịch #${booking.id}` : `đơn nạp ví #${order?.order_code}`;
    const text = `Cảnh báo thanh toán thiếu: ${what} chỉ nhận ${formatVnd(event.amountPaid)} trên ${formatVnd(order?.amount ?? booking?.price_vnd ?? 0)} rồi link đóng. Cần xử lý thủ công (hoàn phần đã nhận).`;
    if (guild) await moneyLog(guild, text);
    alert(text);
    return;
  }

  if (event.kind === "topup") {
    const bonus = order.bonus_vnd > 0 ? ` và được tặng thêm ${formatVnd(order.bonus_vnd)}` : "";
    await sendDm(client, order.user_id, `Đã nạp ${formatVnd(order.amount)} vào ví${bonus}. Số dư hiện tại: ${formatVnd(event.balance)}. Dùng ví để thanh toán khi đặt lịch.`);
    if (guild) await moneyLog(guild, `Nạp ví ${formatVnd(order.amount)}${order.bonus_vnd > 0 ? ` (tặng thêm ${formatVnd(order.bonus_vnd)})` : ""} của ${mention(order.user_id)}.`);
    return;
  }
  if (!booking) return;
  const settings = getSettings();
  const when = formatLocal(booking.start_at, settings.timezone);
  const player = getPlayer(booking.player_id);
  const playerName = player?.displayName ?? mention(booking.player_id);

  if (event.kind === "paid") {
    const dmCustomer = await sendDm(client, booking.customer_id, `${order ? "Đã nhận thanh toán." : "Đã thanh toán bằng ví."} Lịch #${booking.id} với ${playerName} lúc ${when} đã được xác nhận.`);
    await sendDm(client, booking.player_id, `Bạn có lịch mới: ${mention(booking.customer_id)} chơi ${booking.game} lúc ${when}, ${durationText(booking.duration_min)}.`);
    if (guild) {
      if (!dmCustomer) await postLog(guild, "bookingsLogChannelId", `${mention(booking.customer_id)} đã thanh toán lịch #${booking.id} với ${playerName} lúc ${when} (không gửi được tin nhắn riêng).`, [booking.customer_id]);
      await audit(guild, `Lịch #${booking.id} đã xác nhận: ${playerName}, ${booking.game}, ${when}.`);
      await moneyLog(guild, order ? `Nhận ${formatVnd(order.amount)} cho lịch #${booking.id}.` : `Lịch #${booking.id} thanh toán bằng ví: ${formatVnd(booking.price_vnd)}.`);
    }
    return;
  }

  if (event.kind === "late_refund") {
    const amount = formatVnd(order?.amount ?? booking.price_vnd);
    const told = await sendDm(
      client,
      booking.customer_id,
      `Thanh toán của bạn cho lịch #${booking.id} đến sau khi lịch đã hết hạn. Khoản hoàn ${amount} đã được ghi nhận, chủ server sẽ chuyển lại cho bạn.${bankHint(booking.customer_id)}`,
    );
    if (guild) {
      await moneyLog(guild, `Tiền về muộn cho lịch #${booking.id} (${amount}), đã ghi nợ hoàn tiền.`);
      if (!told) await postLog(guild, "bookingsLogChannelId", `${mention(booking.customer_id)} thanh toán muộn lịch #${booking.id}, khoản hoàn đã được ghi nhận.`, [booking.customer_id]);
    }
    return;
  }

  if (event.kind === "extended") {
    const text = `Đã nhận ${formatVnd(order?.amount ?? 0)} gia hạn thêm ${durationText(order?.extra_min ?? 0)}. Buổi hẹn #${booking.id} giờ kết thúc lúc ${formatLocal(booking.start_at + booking.duration_min * 60_000, settings.timezone)}.`;
    const room = booking.text_channel_id ? guild?.channels?.cache?.get(booking.text_channel_id) : null;
    await room?.send?.({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
    await sendDm(client, booking.customer_id, text);
    await sendDm(client, booking.player_id, `Khách đã gia hạn buổi #${booking.id} thêm ${durationText(order?.extra_min ?? 0)}.`);
    if (guild) await moneyLog(guild, order?.order_code ? `Nhận ${formatVnd(order.amount)} gia hạn lịch #${booking.id}.` : `Gia hạn lịch #${booking.id} bằng ví: ${formatVnd(order?.amount ?? 0)}.`);
    return;
  }

  if (event.kind === "extend_failed" || event.kind === "duplicate") {
    const why = event.kind === "duplicate" ? "thanh toán trùng cho lịch đã được thanh toán" : "gia hạn đã trả tiền nhưng buổi không còn gia hạn được";
    const text = `Cần hoàn tiền thủ công: lịch #${booking.id} có ${why}. Số tiền ${formatVnd(order?.amount ?? 0)}, của ${mention(booking.customer_id)} (đơn #${order?.order_code}).`;
    if (guild) await moneyLog(guild, text, [booking.customer_id]);
    await sendDm(client, booking.customer_id, `Khoản ${formatVnd(order?.amount ?? 0)} bạn vừa trả cho lịch #${booking.id} không dùng được (${why}). Chủ server sẽ hoàn lại cho bạn.${bankHint(booking.customer_id)}`);
    alert(text);
    return;
  }

}

export function installNotifier(client) {
  client.notifyBooking = (event) => announce(client, event);
}
