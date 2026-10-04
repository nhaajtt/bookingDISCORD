import { leaderboardEmbed } from "../commands/bangxephang.js";
import { kvGet, kvSet } from "../kv.js";
import { previousMonthKey, recordMonthlyWinners } from "../domain/stats.js";
import { getSettings } from "../settings.js";
import { now } from "../discord/clock.js";
import { channelOf, getGuild } from "../discord/guild.js";
import { refreshAllCards } from "../discord/cards.js";
import { send } from "../discord/respond.js";
import { HOUR } from "../domain/time.js";

// Once a month, posts the winners of the month that just ended in the reviews channel, and refreshes the cards so the "top of the
// month" badge shows. The winners are written down when they are first computed, so the badge does not change afterwards.

export async function runLeaderboard(client, t = now()) {
  const settings = getSettings();
  const key = previousMonthKey(t, settings.timezone);
  if (kvGet(`leaderboard_posted:${key}`)) return { posted: false };
  const winners = recordMonthlyWinners(key, settings);
  const guild = await getGuild(client);
  if (!guild) return { posted: false };
  const channel = await channelOf(guild, "feedbackChannelId");
  if (winners.players.length || winners.customers.length) {
    if (!channel) return { posted: false };
    await send(channel, { embeds: [leaderboardEmbed({ title: `Bảng xếp hạng tháng ${key}`, players: winners.players, customers: winners.customers })] });
  }
  kvSet(`leaderboard_posted:${key}`, String(t));
  await refreshAllCards(guild);
  return { posted: Boolean(winners.players.length || winners.customers.length) };
}

export default {
  name: "leaderboard",
  everyMs: 6 * HOUR,
  run: (client) => runLeaderboard(client),
};
