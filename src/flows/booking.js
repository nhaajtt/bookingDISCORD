import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { getSettings } from "../settings.js";
import { alert } from "../alerts.js";
import { SYSTEM, actorFor, canTransition, cancel, createBooking, getBooking } from "../domain/bookings.js";
import { getPlayer, listPlayers } from "../domain/players.js";
import { getAvailability } from "../domain/availability.js";
import { bankHint } from "../domain/bank.js";
import { normalizeCode } from "../domain/coupons.js";
import { recordRating } from "../domain/ratings.js";
import { refundFor } from "../domain/policy.js";
import { formatVnd, parseDurationText } from "../domain/pricing.js";
import { formatLocal, parseLocalDateTime } from "../domain/time.js";
import { DomainError } from "../domain/errors.js";
import { checkoutBooking } from "../pay/checkout.js";
import { createSeries } from "../domain/series.js";
import { joinButton } from "../commands/hangcho.js";
import { payFromWallet, walletBalance } from "../domain/wallet.js";
import { gate } from "../discord/access.js";
import { refreshCard } from "../discord/cards.js";
import { now } from "../discord/clock.js";
import { channelOf, guildOf, mention, sendDm } from "../discord/guild.js";
import { limited } from "../discord/limits.js";
import { field, modal, rawField } from "../discord/modals.js";
import { afterStrike, audit, moneyLog } from "../discord/moderation.js";
import { isStaff } from "../discord/permissions.js";
import { defer, respond, send } from "../discord/respond.js";
import { COLORS, durationText } from "../discord/text.js";
import { log } from "../log.js";

// The booking flow: pick a player, fill the modal, get a payOS link, pay (the payments job confirms), cancel, rate.

const BUSY = "Hệ thống thanh toán đang bận, bạn thử lại sau ít phút nhé.";
export const BAD_WHEN = "Không hiểu ngày giờ. Ví dụ: 12/10 19:30";
export const BAD_DURATION = "Không hiểu thời lượng. Ví dụ: 1, 1.5 hoặc 90p";

// ---------------------------------------------------------------- choosing a player

// Opens the booking modal for one player after the checks that do not need the form
export async function startBooking(interaction, playerId, game = null, prefill = {}) {
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  if (playerId === interaction.user.id) return respond(interaction, new DomainError("SELF_BOOKING").message);
  const player = getPlayer(playerId);
  if (!player) return respond(interaction, new DomainError("NOT_FOUND", { what: "player" }).message);
  if (player.status !== "ACTIVE") return respond(interaction, new DomainError("PLAYER_NOT_ACTIVE").message);
  if (!getAvailability(playerId).length) return respond(interaction, "Player này chưa nhập lịch rảnh nên chưa đặt được.");
  const guess = game ?? (player.games.length === 1 ? player.games[0] : undefined);
  return interaction.showModal(
    modal(`bk:new:${playerId}`, `Đặt lịch với ${player.displayName}`, [
      { id: "game", label: "Game hoặc chủ đề", max: 40, placeholder: player.games.join(", "), value: guess },
      { id: "when", label: "Ngày giờ", max: 30, placeholder: "DD/MM HH:mm, ví dụ 12/10 19:30", value: prefill.when },
      { id: "duration", label: "Thời lượng", max: 12, placeholder: "1, 1.5, 2 giờ", value: prefill.duration },
      { id: "coupon", label: "Mã giảm giá (nếu có)", max: 20, required: false },
      ...(getSettings().maxSeriesWeeks > 0 ? [{ id: "repeat", label: "Lặp lại hằng tuần (số tuần, nếu muốn)", max: 2, required: false, placeholder: "Ví dụ 4 = cả buổi này và 3 tuần tiếp theo" }] : []),
    ]),
  );
}

// A private menu of the players who can be booked now (25 at most, the limit of a menu)
export async function showPicker(interaction) {
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const players = listPlayers({ status: "ACTIVE" }).filter((p) => p.userId !== interaction.user.id && getAvailability(p.userId).length).slice(0, 25);
  if (!players.length) return respond(interaction, "Hiện chưa có player nào nhận lịch. Bạn quay lại sau nhé.");
  const menu = new StringSelectMenuBuilder()
    .setCustomId("bk:pickplayer")
    .setPlaceholder("Chọn player")
    .addOptions(players.map((p) => ({ label: `${p.displayName} | ${formatVnd(p.rateVnd)}/giờ`.slice(0, 100), description: p.games.join(", ").slice(0, 100), value: p.userId })));
  return respond(interaction, { content: "Chọn player bạn muốn đặt lịch:", components: [new ActionRowBuilder().addComponents(menu)] });
}

async function onCardButton(interaction, [playerId]) {
  return startBooking(interaction, playerId);
}

async function onPicked(interaction) {
  return startBooking(interaction, interaction.values[0]);
}

// ---------------------------------------------------------------- creating the booking and the payment link

export function paymentEmbed(booking, player, settings, checkoutUrl) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`Lịch #${booking.id} chờ thanh toán`)
        .addFields(
          { name: "Player", value: player?.displayName ?? mention(booking.player_id), inline: true },
          { name: "Game", value: booking.game, inline: true },
          { name: "Thời gian", value: formatLocal(booking.start_at, settings.timezone), inline: true },
          { name: "Thời lượng", value: durationText(booking.duration_min), inline: true },
          { name: "Giá", value: booking.discount_vnd > 0 ? `~~${formatVnd(booking.list_price_vnd)}~~ ${formatVnd(booking.price_vnd)}` : formatVnd(booking.price_vnd), inline: true },
          ...(booking.discount_vnd > 0 ? [{ name: "Mã giảm giá", value: `${booking.coupon_code}: giảm ${formatVnd(booking.discount_vnd)}`, inline: true }] : []),
        )
        .setFooter({ text: `Thanh toán trong ${settings.unpaidExpireMin} phút, sau đó lịch tự huỷ.` }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(checkoutUrl).setLabel("Thanh toán"),
        new ButtonBuilder().setCustomId(`bk:cancel:${booking.id}`).setLabel("Huỷ lịch").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function submitNew(interaction, [playerId]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "book");
  if (refusal) return respond(interaction, refusal);
  const settings = getSettings();
  const t = now();
  const startAt = parseLocalDateTime(rawField(interaction, "when"), settings.timezone, t);
  if (startAt === null) return respond(interaction, BAD_WHEN);
  const durationMin = parseDurationText(rawField(interaction, "duration"));
  if (durationMin === null) return respond(interaction, BAD_DURATION);

  const repeatText = rawField(interaction, "repeat");
  const weeks = repeatText ? Number(repeatText) : null;
  if (weeks !== null && !(Number.isInteger(weeks) && weeks >= 2 && weeks <= settings.maxSeriesWeeks)) {
    return respond(interaction, settings.maxSeriesWeeks > 0 ? `Số tuần lặp phải từ 2 đến ${settings.maxSeriesWeeks}, hoặc bỏ trống nếu chỉ đặt một lần.` : "Đặt lặp hằng tuần đang tắt.");
  }
  const couponCode = normalizeCode(rawField(interaction, "coupon")) || null;
  if (couponCode) {
    const tooMany = limited(interaction.user.id, "coupon");
    if (tooMany) return respond(interaction, tooMany);
  }
  let booking;
  try {
    booking = createBooking({ customerId: interaction.user.id, playerId, game: field(interaction, "game", 40), startAt, durationMin, couponCode }, t);
  } catch (error) {
    // A taken slot can be waited for: the customer is offered to be told when it frees up
    const player = getPlayer(playerId);
    if ((error.code === "PLAYER_BUSY" || error.code === "SLOT_HELD") && player?.games.some((g) => g.toLowerCase() === field(interaction, "game", 40).toLowerCase())) {
      return respond(interaction, { content: `${error.message}\nMuốn được báo khi có chỗ trống không?`, components: [new ActionRowBuilder().addComponents(joinButton(playerId, startAt, durationMin, field(interaction, "game", 40), player))] });
    }
    throw error;
  }

  const series = weeks ? createSeries({ bookingId: booking.id, weeks }, t, settings) : null;
  const view = await continueToPayment(interaction.user.id, booking, settings, t);
  if (series && typeof view === "object") view.content = `Đã đặt lặp ${weeks} tuần. Mình sẽ nhắn bạn trước 3 ngày để xác nhận từng tuần tiếp theo, không tự trừ tiền. Dừng bất cứ lúc nào bằng /hangcho.`;
  return respond(interaction, view);
}

// A customer whose wallet covers the price chooses between the wallet and a payment link; the link is only made if they ask for it,
// so there is never a second way to pay the same booking.
export async function continueToPayment(customerId, booking, settings, t) {
  const balance = walletBalance(customerId);
  if (balance >= booking.price_vnd) return walletChoice(booking, getPlayer(booking.player_id), settings, balance);
  return linkOrFail(booking, getPlayer(booking.player_id), settings, t);
}

// Makes the payment link for a booking and answers with it. When no gateway can make one the booking is cancelled again (nothing was
// paid) and the customer is asked to try later.
async function linkOrFail(booking, player, settings, t) {
  try {
    const link = await checkoutBooking(booking, t, null, settings);
    return paymentEmbed(booking, player, settings, link.checkoutUrl);
  } catch (error) {
    log.error("payment.link_failed", { booking: booking.id, error });
    alert(`Không tạo được link thanh toán cho lịch #${booking.id}: ${error.message}`);
    try {
      cancel(booking.id, SYSTEM, t, { reason: "không tạo được link thanh toán" });
    } catch (inner) {
      log.error("booking.cancel_after_payment_failure_failed", { booking: booking.id, error: inner });
    }
    return BUSY;
  }
}

function walletChoice(booking, player, settings, balance) {
  const view = paymentEmbed(booking, player, settings, "https://example.invalid/");
  const embed = view.embeds[0].setTitle(`Lịch #${booking.id}: chọn cách thanh toán`).setFooter({ text: `Ví của bạn còn ${formatVnd(balance)}. Thanh toán trong ${settings.unpaidExpireMin} phút, sau đó lịch tự huỷ.` });
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bk:wallet:${booking.id}`).setLabel(`Trả bằng ví (còn ${formatVnd(balance - booking.price_vnd)})`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bk:paylink:${booking.id}`).setLabel("Chuyển khoản / thẻ").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bk:cancel:${booking.id}`).setLabel("Huỷ lịch").setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

async function payWithWallet(interaction, [id]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "wallet");
  if (refusal) return respond(interaction, refusal);
  const { booking, balance } = payFromWallet(Number(id), interaction.user.id, now());
  await interaction.client.notifyBooking?.({ kind: "paid", booking, order: null });
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, { content: `Đã thanh toán lịch #${booking.id} bằng ví. Ví còn ${formatVnd(balance)}.`, embeds: [], components: [] });
}

async function payWithLink(interaction, [id]) {
  await defer(interaction);
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const booking = mustGet(id);
  if (booking.customer_id !== interaction.user.id) throw new DomainError("FORBIDDEN_ACTOR");
  if (booking.status !== "AWAITING_PAYMENT") throw new DomainError("ILLEGAL_TRANSITION", { status: booking.status, action: "thanh toán" });
  const settings = getSettings();
  const view = await linkOrFail(booking, getPlayer(booking.player_id), settings, now());
  return respond(interaction, view);
}

// ---------------------------------------------------------------- cancelling

function actorOf(interaction, booking) {
  return actorFor(booking, interaction.user.id, { isStaff: isStaff(interaction.member, interaction.user.id) });
}

function mustGet(id) {
  const booking = getBooking(Number(id));
  if (!booking) throw new DomainError("NOT_FOUND", { what: "lịch" });
  return booking;
}

export function cancelPreview(booking, actor, t, settings = getSettings()) {
  const decision = refundFor(booking, actor.role, t, settings.cancellation);
  if (booking.status === "AWAITING_PAYMENT") return { decision, text: "Lịch này chưa thanh toán nên huỷ không mất phí." };
  if (actor.role === "player") return { decision, text: "Huỷ lịch sẽ hoàn 100% cho khách và bạn bị 1 cảnh cáo." };
  if (actor.role === "customer") {
    const tail = decision.refundVnd > 0 ? " Khoản hoàn được ghi nhận, chủ server sẽ chuyển lại cho bạn." : "";
    return { decision, text: `Nếu huỷ bây giờ bạn được hoàn ${decision.percent}% (${formatVnd(decision.refundVnd)}).${tail}` };
  }
  return { decision, text: `Huỷ lịch sẽ hoàn ${decision.percent}% (${formatVnd(decision.refundVnd)}) cho khách.` };
}

async function askCancel(interaction, [id]) {
  await defer(interaction);
  const staff = isStaff(interaction.member, interaction.user.id);
  const refusal = staff ? null : gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const booking = mustGet(id);
  const actor = actorOf(interaction, booking);
  if (!canTransition(booking.status, "cancel", actor.role)) throw new DomainError("ILLEGAL_TRANSITION", { status: booking.status, action: "huỷ" });
  const { text } = cancelPreview(booking, actor, now());
  return respond(interaction, {
    content: `Huỷ lịch #${booking.id}?\n${text}`,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bk:cancel:yes:${booking.id}`).setLabel("Xác nhận huỷ").setStyle(ButtonStyle.Danger))],
  });
}

// Cancels and tells everyone it concerns. Used by the confirm button, /staff huy-lich and the "cancel upcoming" button.
export async function cancelAndNotify(guild, client, bookingId, actor, reason = null) {
  const before = mustGet(bookingId);
  const result = cancel(bookingId, actor, now(), { reason });
  const booking = result.booking;
  const player = getPlayer(booking.player_id);
  const amount = formatVnd(result.refundVnd);
  const wasPaid = before.status !== "AWAITING_PAYMENT";
  const refundNote = wasPaid && result.refundVnd > 0 ? ` Khoản hoàn ${amount} đã được ghi nhận, chủ server sẽ chuyển lại cho bạn.${bankHint(booking.customer_id)}` : "";

  if (actor.role !== "customer") await sendDm(client, booking.customer_id, `Lịch #${booking.id} với ${player?.displayName ?? "player"} đã bị huỷ.${refundNote}`);
  if (actor.role !== "player") await sendDm(client, booking.player_id, `Lịch #${booking.id} đã bị huỷ${actor.role === "customer" ? " bởi khách" : ""}.`);
  if (guild) {
    if (booking.text_channel_id) {
      const room = guild.channels.cache.get(booking.text_channel_id);
      await room?.send({ content: `Lịch #${booking.id} đã bị huỷ. Phòng sẽ đóng sau ít phút.`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    const who = actor.role === "staff" ? `nhân viên ${mention(actor.userId)}` : actor.role === "player" ? "player" : actor.role === "customer" ? "khách" : "hệ thống";
    await audit(guild, `Lịch #${booking.id} bị huỷ bởi ${who}${reason ? ` (${reason})` : ""}.`);
    if (wasPaid) await moneyLog(guild, `Huỷ lịch #${booking.id} bởi ${who}: hoàn ${amount}${result.refundVnd < before.price_vnd ? `, giữ ${formatVnd(before.price_vnd - result.refundVnd)}` : ""}.`);
    if (result.strike) await afterStrike(guild, booking.player_id, result.strike);
  }
  return result;
}

async function confirmCancel(interaction, [id]) {
  await defer(interaction);
  const staff = isStaff(interaction.member, interaction.user.id);
  const refusal = staff ? null : gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const booking = mustGet(id);
  const actor = actorOf(interaction, booking);
  const result = await cancelAndNotify(await guildOf(interaction), interaction.client, booking.id, actor, actor.role === "staff" ? "nhân viên huỷ" : null);
  const amount = formatVnd(result.refundVnd);
  if (booking.status === "AWAITING_PAYMENT") return respond(interaction, { content: `Đã huỷ lịch #${booking.id}.`, components: [] });
  if (actor.role === "player") return respond(interaction, { content: `Đã huỷ lịch #${booking.id}. Khách được hoàn 100%.${result.strike?.suspended ? " Bạn đã bị tạm khoá do đủ số cảnh cáo." : " Bạn bị 1 cảnh cáo."}`, components: [] });
  return respond(interaction, { content: `Đã huỷ lịch #${booking.id}. ${result.refundVnd > 0 ? `Khoản hoàn ${amount} đã được ghi nhận, chủ server sẽ chuyển lại cho bạn.` : "Lịch này không được hoàn tiền theo chính sách huỷ."}`, components: [] });
}

// ---------------------------------------------------------------- rating

export const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

async function askReview(interaction, [id, count]) {
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new DomainError("BAD_STARS");
  const booking = mustGet(id);
  if (booking.customer_id !== interaction.user.id) throw new DomainError("FORBIDDEN_ACTOR");
  return interaction.showModal(modal(`bk:rate:submit:${booking.id}:${n}`, `Đánh giá ${n} sao`, [{ id: "review", label: "Nhận xét (không bắt buộc)", max: 300, paragraph: true, required: false }]));
}

async function submitReview(interaction, [id, count]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "rate");
  if (refusal) return respond(interaction, refusal);
  const n = Number(count);
  const { booking, player } = recordRating(Number(id), interaction.user.id, n, field(interaction, "review", 300), now());
  const profile = getPlayer(booking.player_id);
  const guild = await guildOf(interaction);
  const feedback = await channelOf(guild, "feedbackChannelId");
  if (feedback) {
    await send(feedback, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.ok)
          .setTitle(`${stars(n)} cho ${profile?.displayName ?? "player"}`)
          .setDescription(booking.review || "Không có nhận xét.")
          .addFields({ name: "Game", value: booking.game, inline: true }, { name: "Đánh giá trung bình", value: `${player.average} (${player.count} lượt)`, inline: true })
          .setFooter({ text: `Lịch #${booking.id}` }),
      ],
    }).catch((error) => log.error("review.post_failed", { error }));
  }
  await refreshCard(guild, booking.player_id).catch((error) => log.error("card.refresh_failed", { user: booking.player_id, error }));
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  const again = profile?.status === "ACTIVE" ? [new ActionRowBuilder().addComponents(againButton(booking.id, profile.displayName))] : [];
  return respond(interaction, { content: "Cảm ơn bạn đã đánh giá!", components: again });
}

// ---------------------------------------------------------------- booking again

export const againButton = (bookingId, playerName) => new ButtonBuilder().setCustomId(`bk:again:${bookingId}`).setLabel(`Đặt lại với ${playerName}`.slice(0, 80)).setStyle(ButtonStyle.Success);

// The same player and game as an earlier booking of this customer, straight into the booking form
async function bookAgain(interaction, [id]) {
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const booking = mustGet(id);
  if (booking.customer_id !== interaction.user.id) throw new DomainError("FORBIDDEN_ACTOR");
  return startBooking(interaction, booking.player_id, booking.game);
}

export default {
  buttons: {
    "bk:pick": showPicker,
    "pl:book": onCardButton,
    "bk:cancel": askCancel,
    "bk:cancel:yes": confirmCancel,
    "bk:rate": askReview,
    "bk:again": bookAgain,
    "bk:wallet": payWithWallet,
    "bk:paylink": payWithLink,
  },
  selects: { "bk:pickplayer": onPicked },
  modals: { "bk:new": submitNew, "bk:rate:submit": submitReview },
};
