import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { getPlayer } from "../domain/players.js";
import { getEntry, joinWaitlist, leaveWaitlist, listForCustomer } from "../domain/waitlist.js";
import { listSeries } from "../domain/series.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS, durationText } from "../discord/text.js";
import { DomainError } from "../domain/errors.js";
import { startBooking } from "../flows/booking.js";

// The waiting list for slots that were taken. A customer joins from the "slot is busy" answer of the booking form, is told by a private
// message when it frees up, and can see and leave the list here.

export const joinButton = (playerId, startAt, durationMin, game, player) =>
  new ButtonBuilder().setCustomId(`wt:join:${playerId}:${startAt}:${durationMin}:${Math.max(0, player.games.findIndex((g) => g.toLowerCase() === String(game).toLowerCase()))}`).setLabel("Báo tôi khi có chỗ").setStyle(ButtonStyle.Primary);

async function join(interaction, [playerId, startAt, durationMin, gameIndex]) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "waitlist");
  if (refusal) return respond(interaction, refusal);
  const player = getPlayer(playerId);
  if (!player) throw new DomainError("NOT_FOUND", { what: "player" });
  const entry = joinWaitlist({ customerId: interaction.user.id, playerId, game: player.games[Number(gameIndex)], startAt: Number(startAt), durationMin: Number(durationMin) }, now());
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, `Đã đăng ký chờ ${player.displayName} lúc ${formatLocal(entry.startAt, getSettings().timezone)}, ${durationText(entry.durationMin)}. Mình sẽ nhắn riêng cho bạn ngay khi chỗ trống. Xem lại bằng /hangcho.`);
}

async function book(interaction, [id]) {
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const entry = getEntry(Number(id));
  if (!entry || entry.customerId !== interaction.user.id || entry.doneAt !== null) return respond(interaction, "Lượt chờ này đã hết hạn hoặc đã xong.");
  const zone = getSettings().timezone;
  const p = formatLocal(entry.startAt, zone).split(" ");
  return startBooking(interaction, entry.playerId, entry.game, { when: `${p[1]} ${p[2]}`, duration: String(entry.durationMin / 60) });
}

async function leave(interaction, [id]) {
  await defer(interaction);
  const refusal = gate(interaction, "user");
  if (refusal) return respond(interaction, refusal);
  const ok = leaveWaitlist(Number(id), interaction.user.id, now());
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
  return respond(interaction, ok ? "Đã bỏ chờ." : "Lượt chờ này đã hết hạn hoặc đã xong.");
}

export default {
  data: new SlashCommandBuilder().setName("hangcho").setDescription("Các chỗ bạn đang chờ khi player kín lịch").setDMPermission(false),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user");
    if (refusal) return respond(interaction, refusal);
    const entries = listForCustomer(interaction.user.id);
    const repeats = listSeries(interaction.user.id);
    if (!entries.length && !repeats.length) return respond(interaction, "Bạn không chờ chỗ nào và không có lịch lặp. Khi player kín lịch, bấm Báo tôi khi có chỗ; muốn lặp hằng tuần, điền số tuần khi đặt lịch.");
    const zone = getSettings().timezone;
    const embed = new EmbedBuilder().setColor(COLORS.info).setTitle("Chờ chỗ và lịch lặp");
    if (entries.length) embed.addFields({ name: "Đang chờ chỗ", value: entries.map((e) => `#${e.id} | ${getPlayer(e.playerId)?.displayName ?? "player"} | ${formatLocal(e.startAt, zone)} | ${durationText(e.durationMin)} | ${e.game}${e.notifiedAt ? " | đã báo, đang giữ chỗ" : ""}`).join("\n").slice(0, 1000) });
    if (repeats.length) embed.addFields({ name: "Lặp hằng tuần", value: repeats.map((s) => `#${s.id} | ${getPlayer(s.playerId)?.displayName ?? "player"} | tuần tới ${formatLocal(s.nextAt, zone)} | ${durationText(s.durationMin)} | còn ${s.remaining} tuần`).join("\n").slice(0, 1000) });
    const buttons = [
      ...entries.slice(0, 5).map((e) => new ButtonBuilder().setCustomId(`wt:leave:${e.id}`).setLabel(`Bỏ chờ #${e.id}`).setStyle(ButtonStyle.Secondary)),
      ...repeats.slice(0, 5).map((s) => new ButtonBuilder().setCustomId(`sr:stop:${s.id}`).setLabel(`Dừng lặp #${s.id}`).setStyle(ButtonStyle.Danger)),
    ];
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return respond(interaction, { embeds: [embed], components: rows });
  },

  buttons: { "wt:join": join, "wt:book": book, "wt:leave": leave },
};
