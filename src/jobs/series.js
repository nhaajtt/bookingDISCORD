import { ActionRowBuilder } from "discord.js";
import { advanceSeries, dueSeries, lastReminded, markReminded } from "../domain/series.js";
import { getPlayer } from "../domain/players.js";
import { quoteBooking } from "../domain/quoting.js";
import { slotIsFree } from "../domain/waitlist.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { now } from "../discord/clock.js";
import { sendDm } from "../discord/guild.js";
import { durationText } from "../discord/text.js";
import { joinButton } from "../commands/hangcho.js";
import { seriesRow } from "../flows/series.js";
import { log } from "../log.js";

// Three days before each week of a repeat, asks the customer to confirm that week. The week is not booked and nothing is charged until
// they press the button. A week whose slot is already taken is skipped with an offer to wait for it; a week nobody answered for
// is dropped when its time comes.

export async function runSeries(client, t = now()) {
  const settings = getSettings();
  let offered = 0;
  for (const s of dueSeries(t)) {
    try {
      if (s.nextAt <= t) {
        advanceSeries(s.id);
        continue;
      }
      if (lastReminded(s.id) === s.nextAt) continue;
      const player = getPlayer(s.playerId);
      const when = formatLocal(s.nextAt, settings.timezone);
      if (!player || player.status !== "ACTIVE") {
        await sendDm(client, s.customerId, `Lặp hằng tuần: ${player?.displayName ?? "player"} hiện không nhận lịch nên tuần ${when} được bỏ qua.`);
        advanceSeries(s.id);
        continue;
      }
      if (!slotIsFree(s.playerId, s.nextAt, s.durationMin, t, settings)) {
        const row = new ActionRowBuilder().addComponents(joinButton(s.playerId, s.nextAt, s.durationMin, s.game, player));
        await sendDm(client, s.customerId, { content: `Lặp hằng tuần: ${player.displayName} đã có lịch khác lúc ${when} nên tuần này chưa đặt được. Muốn được báo khi có chỗ không?`, components: [row] });
        advanceSeries(s.id);
        continue;
      }
      let price = "";
      try {
        price = ` Giá ${formatVnd(quoteBooking({ player, game: s.game, startAt: s.nextAt, durationMin: s.durationMin, userId: s.customerId, now: t }, settings).priceVnd)}.`;
      } catch {
        price = "";
      }
      const sent = await sendDm(client, s.customerId, {
        content: `Lặp hằng tuần: tuần tới bạn có hẹn ${player.displayName} lúc ${when}, ${durationText(s.durationMin)}, ${s.game}.${price} Bấm Đặt tuần này để xác nhận và thanh toán; chưa bấm thì chưa mất gì và chưa giữ chỗ.`,
        components: [seriesRow(s)],
      });
      if (sent) {
        markReminded(s.id, s.nextAt);
        offered += 1;
      }
    } catch (error) {
      log.error("series.failed", { series: s.id, error });
    }
  }
  return { offered };
}

export default {
  name: "series",
  everyMs: 30 * 60_000,
  run: (client) => runSeries(client),
};
