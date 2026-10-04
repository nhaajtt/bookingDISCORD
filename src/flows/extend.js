import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { alert } from "../alerts.js";
import { getBooking } from "../domain/bookings.js";
import { quoteExtension } from "../domain/extensions.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { payExtensionFromWallet } from "../domain/wallet.js";
import { DomainError } from "../domain/errors.js";
import { getSettings } from "../settings.js";
import { checkoutExtension } from "../pay/checkout.js";
import { manualExtras } from "./manualpay.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";
import { durationText } from "../discord/text.js";
import { log } from "../log.js";

// "Add time" inside a running session. The customer picks 30, 60, 90 or 120 minutes (as far as the player is free and the owner allows),
// pays by the same means as the booking, and the session simply gets longer.

const STEPS = [30, 60, 90, 120, 150, 180, 210, 240];

export const extendButton = (bookingId) => new ButtonBuilder().setCustomId(`bk:extend:${bookingId}`).setLabel("Gia hạn").setStyle(ButtonStyle.Success);

async function offer(interaction, [id]) {
  await defer(interaction);
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const booking = getBooking(Number(id));
  if (!booking) throw new DomainError("NOT_FOUND", { what: "lịch" });
  if (booking.customer_id !== interaction.user.id) return respond(interaction, "Chỉ khách đặt lịch mới gia hạn được.");
  const settings = getSettings();
  const t = now();
  const options = [];
  let reason = null;
  for (const step of STEPS.filter((s) => s <= settings.maxExtendMin)) {
    try {
      const q = quoteExtension(booking.id, step, t, settings);
      options.push({ label: `Thêm ${durationText(step)}: ${formatVnd(q.priceVnd)}`, description: `Kết thúc lúc ${formatLocal(q.newEndAt, settings.timezone)}`, value: String(step) });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      reason ??= error.message;
      break;
    }
  }
  if (!options.length) return respond(interaction, reason ?? "Không thể gia hạn buổi này.");
  const method = booking.paid_with === "WALLET" ? "Tiền sẽ trừ từ ví của bạn." : "Bạn sẽ nhận link thanh toán.";
  return respond(interaction, {
    content: `Gia hạn buổi #${booking.id}. ${method}`,
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`bk:extendpick:${booking.id}`).setPlaceholder("Chọn thời gian thêm").addOptions(options))],
  });
}

async function picked(interaction, [id]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "extend");
  if (refusal) return respond(interaction, refusal);
  const extraMin = Number(interaction.values?.[0]);
  const settings = getSettings();
  const t = now();
  const quote = quoteExtension(Number(id), extraMin, t, settings);
  if (quote.booking.customer_id !== interaction.user.id) return respond(interaction, "Chỉ khách đặt lịch mới gia hạn được.");

  if (quote.booking.paid_with === "WALLET") {
    const done = payExtensionFromWallet(quote.booking.id, interaction.user.id, extraMin, t, settings);
    await interaction.client.notifyBooking?.({ kind: "extended", booking: done.booking, order: { amount: done.priceVnd, extra_min: extraMin } });
    return respond(interaction, { content: `Đã gia hạn thêm ${durationText(extraMin)}, trừ ${formatVnd(done.priceVnd)} từ ví (còn ${formatVnd(done.balance)}).`, components: [] });
  }
  try {
    const link = await checkoutExtension(quote.booking, extraMin, quote.priceVnd, quote.feeVnd, t);
    const manual = manualExtras(link.orderCode);
    return respond(interaction, {
      content: `Gia hạn thêm ${durationText(extraMin)}: ${formatVnd(quote.priceVnd)}. Thanh toán trong 15 phút, giờ thêm được giữ cho bạn trong lúc đó.${manual ? ` ${manual.text}` : ""}`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(link.checkoutUrl).setLabel(manual ? manual.linkLabel : "Thanh toán gia hạn"), ...(manual ? [manual.button] : []))],
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    log.error("payment.extend_link_failed", { booking: quote.booking.id, error });
    alert(`Không tạo được link gia hạn cho lịch #${quote.booking.id}: ${error.message}`);
    return respond(interaction, "Hệ thống thanh toán đang bận, bạn thử lại sau ít phút nhé.");
  }
}

export default {
  buttons: { "bk:extend": offer },
  selects: { "bk:extendpick": picked },
};
