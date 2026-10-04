import { Events } from "discord.js";

// Every interaction goes through the one router built in index.js (commands, buttons, modals, menus, autocomplete)
export default {
  name: Events.InteractionCreate,
  async execute(client, interaction) {
    await client.router.dispatch(interaction);
  },
};
