// In multi-server mode a button in a private message does not say which server it belongs to, because a private message has no server.
// So every button, menu and form the bot puts in a private message carries the server id at the end of its custom id ("bk:rate:5:4@123...").
// The router strips it, runs the click inside that server's data, and tags whatever the answer contains in turn.

export const TAG = /@(\d{17,20})$/;

export const split = (customId) => {
  const m = typeof customId === "string" ? TAG.exec(customId) : null;
  return m ? { customId: customId.slice(0, m.index), guildId: m[1] } : { customId, guildId: null };
};

const dataOf = (component) => component?.data ?? component;

export function tagComponents(components, guildId) {
  if (!guildId || !Array.isArray(components)) return components;
  for (const row of components) {
    const list = row?.components ?? row?.data?.components ?? [];
    for (const component of list) {
      const data = dataOf(component);
      const id = data?.custom_id;
      if (typeof id === "string" && !data.url && !TAG.test(id)) data.custom_id = `${id}@${guildId}`;
    }
  }
  return components;
}

export function tagModal(modal, guildId) {
  const data = dataOf(modal);
  if (guildId && typeof data?.custom_id === "string" && !TAG.test(data.custom_id)) data.custom_id = `${data.custom_id}@${guildId}`;
  return modal;
}

// Makes the answers to a private-message interaction carry the tag: reply, editReply, followUp, update and showModal
export function tagAnswers(interaction, guildId) {
  for (const name of ["reply", "editReply", "followUp", "update"]) {
    const original = interaction[name]?.bind(interaction);
    if (!original) continue;
    interaction[name] = (payload, ...rest) => {
      if (payload && typeof payload === "object") tagComponents(payload.components, guildId);
      return original(payload, ...rest);
    };
  }
  const showModal = interaction.showModal?.bind(interaction);
  if (showModal) interaction.showModal = (modal) => showModal(tagModal(modal, guildId));
}
