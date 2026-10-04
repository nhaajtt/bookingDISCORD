import { listBookings } from "../domain/bookings.js";
import { listPlayers } from "../domain/players.js";
import { regularCustomerChanges, trustedRoleChanges } from "../domain/ratings.js";
import { DAY } from "../domain/time.js";
import { fetchMemberState, getGuild } from "../discord/guild.js";
import { handlePlayerBack, handlePlayerLeft } from "../discord/departures.js";
import { grantRole, holdsRole, revokeRole } from "../discord/roles.js";

// The daily trust roles. Without the members intent the bot cannot list who holds a role, so it looks at the people who could hold one
// (every player, every customer with a completed booking), fetching each member by REST one at a time. A person who left is skipped.
// Holders who are not candidates are left alone, so a role given by hand is never taken away.
export async function runRoles(client) {
  const guild = await getGuild(client);
  if (!guild) return { granted: 0, removed: 0 };

  const ids = new Set(listPlayers().map((p) => p.userId));
  for (const b of listBookings({ statuses: ["COMPLETED"], limit: 100_000 })) ids.add(b.customer_id);

  const members = new Map();
  const players = new Map(listPlayers().map((p) => [p.userId, p]));
  for (const id of ids) {
    const state = await fetchMemberState(guild, id);
    const player = players.get(id);
    if (state.member) {
      members.set(id, state.member);
      if (player?.leftAt) await handlePlayerBack(client, id);
    } else if (state.gone && player && ["ACTIVE", "PAUSED"].includes(player.status) && !player.leftAt) {
      await handlePlayerLeft(client, guild, id);
    }
  }

  let granted = 0;
  let removed = 0;
  for (const [kind, changes] of [["trusted", trustedRoleChanges], ["regular", regularCustomerChanges]]) {
    const holders = [...members].filter(([, member]) => holdsRole(guild, member, kind)).map(([id]) => id);
    const { gain, lose } = changes(holders);
    for (const id of gain) {
      const member = members.get(id);
      if (member && (await grantRole(guild, id, kind, { member, reason: "Đủ điều kiện" })).ok) granted += 1;
    }
    for (const id of lose) {
      const member = members.get(id);
      if (member && (await revokeRole(guild, id, kind, { member, reason: "Không còn đủ điều kiện" })).ok) removed += 1;
    }
  }
  return { granted, removed };
}

export default {
  name: "roles",
  everyMs: DAY,
  run: (client) => runRoles(client),
};
