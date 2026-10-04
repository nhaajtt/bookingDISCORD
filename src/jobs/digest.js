import { ownerSummary } from "../domain/summary.js";
import { HOUR, localParts } from "../domain/time.js";
import { getSettings } from "../settings.js";
import { kvGet, kvSet } from "../kv.js";
import { now } from "../discord/clock.js";
import { getGuild, postLog } from "../discord/guild.js";
import { summaryEmbed } from "../discord/text.js";
import { config } from "../config.js";
import { currentTenant } from "../db.js";
import { licenseStatus } from "../license.js";

// The owner's digest in the money log (owner only): every morning from 08:00 a short picture of yesterday and today, and on Monday the
// whole week instead. Each is posted once per local date, remembered in the kv table so a restart does not repeat it.
export const DIGEST_HOUR = 8;

export async function runDigest(client, { now: t = now() } = {}) {
  const guild = await getGuild(client);
  if (!guild) return null;
  const settings = getSettings();
  const local = localParts(t, settings.timezone);
  if (local.hour < DIGEST_HOUR) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
  const weekly = local.weekday === 1;
  const key = weekly ? "digest:weekly" : "digest:daily";
  if (kvGet(key) === dateKey) return null;

  const summary = ownerSummary(t, { periodDays: weekly ? 7 : 2, settings });
  const title = weekly ? "Tổng kết tuần" : "Tóm tắt buổi sáng (hôm qua và hôm nay)";
  // In multi-server mode the owner hears about a license that is about to end
  const lic = config.multiTenant && config.licenseRequired && currentTenant() ? licenseStatus(currentTenant(), t) : null;
  const warning = lic && (lic.state !== "active" || lic.daysLeft <= 7) ? `Giấy phép ${lic.state === "active" ? `còn ${lic.daysLeft} ngày` : "đã hết hạn"}. Gia hạn bằng /kichhoat với mã mới.` : undefined;
  const sent = await postLog(guild, "moneyLogChannelId", { content: warning, embeds: [summaryEmbed(summary, settings, title)] });
  if (!sent) return null;
  kvSet(key, dateKey);
  return weekly ? "weekly" : "daily";
}

export default {
  name: "digest",
  everyMs: HOUR,
  run: (client) => runDigest(client),
};
