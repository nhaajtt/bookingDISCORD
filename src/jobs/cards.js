import { DAY } from "../domain/time.js";
import { refreshAllCards } from "../discord/cards.js";
import { channelOf, getGuild } from "../discord/guild.js";
import { ensurePanel } from "../discord/layout.js";
import { guidePanel, MARKERS } from "../discord/panels.js";
import { log } from "../log.js";

// Daily: every active player's card (ratings and badges) and the guide, whose cancellation table is built from the live settings
export async function runCards(client) {
  const guild = await getGuild(client);
  if (!guild) return { cards: 0 };
  const cards = await refreshAllCards(guild);
  const guide = await channelOf(guild, "guideChannelId");
  if (guide) await ensurePanel(guide, MARKERS.guide, guidePanel(), client.user?.id).catch((error) => log.error("guide.refresh_failed", { error }));
  return { cards };
}

export default {
  name: "cards",
  everyMs: DAY,
  run: (client) => runCards(client),
};
