import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { createBooking } from "../domain/bookings.js";
import { DomainError } from "../domain/errors.js";
import { getPlayer } from "../domain/players.js";
import { advanceSeries, getSeries, stopSeries } from "../domain/series.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";
import { continueToPayment } from "./booking.js";

// The buttons of a weekly repeat. Each reminder carries the start time of the week it offers, so a button from an old message can
// never book some other week.

export const seriesRow = (series) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sr:book:${series.id}:${series.nextAt}`).setLabel("Đặt tuần này").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sr:skip:${series.id}:${series.nextAt}`).setLabel("Bỏ tuần này").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sr:stop:${series.id}`).setLabel("Dừng lặp").setStyle(ButtonStyle.Danger),
  );

function mine(interaction, id, nextAt) {
  const series = getSeries(Number(id));
  if (!series || series.customerId !== interaction.user.id) throw new DomainError("FORBIDDEN_ACTOR");
  if (!series.active) return { stale: "Chuỗi lặp này đã dừng." };
  if (nextAt !== undefined && series.nextAt !== Number(nextAt)) return { stale: "Tin nhắn này đã cũ, tuần này đã được xử lý rồi." };
  return { series };
}

async function book(interaction, [id, nextAt]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "book");
  if (refusal) return respond(interaction, refusal);
  const found = mine(interaction, id, nextAt);
  if (found.stale) return respond(interaction, found.stale);
  const { series } = found;
  const settings = getSettings();
  const t = now();
  const booking = createBooking({ customerId: series.customerId, playerId: series.playerId, game: series.game, startAt: series.nextAt, durationMin: series.durationMin, seriesId: series.id }, t, settings);
  advanceSeries(series.id);
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  const view = await continueToPayment(interaction.user.id, booking, settings, t);
  return respond(interaction, view);
}

async function skip(interaction, [id, nextAt]) {
  await defer(interaction);
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const found = mine(interaction, id, nextAt);
  if (found.stale) return respond(interaction, found.stale);
  const next = advanceSeries(found.series.id);
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, next.active ? `Đã bỏ tuần này. Còn ${next.remaining} tuần trong chuỗi.` : "Đã bỏ tuần này, chuỗi lặp đã hết.");
}

async function stop(interaction, [id]) {
  await defer(interaction);
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const found = mine(interaction, id);
  if (found.stale) return respond(interaction, found.stale);
  stopSeries(found.series.id, interaction.user.id);
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  const name = getPlayer(found.series.playerId)?.displayName ?? "player";
  return respond(interaction, `Đã dừng lặp hằng tuần với ${name}. Các lịch đã đặt vẫn giữ nguyên.`);
}

export default {
  buttons: { "sr:book": book, "sr:skip": skip, "sr:stop": stop },
};
