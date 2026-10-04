import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

// The buttons of the trust and safety flows, kept apart from the handlers so rooms and jobs can use them without importing the flows

export const alertButton = (bookingId) => new ButtonBuilder().setCustomId(`sf:alert:${bookingId}`).setLabel("Báo khẩn").setStyle(ButtonStyle.Danger);

export const customerRatingRows = (bookingId) => [
  new ActionRowBuilder().addComponents([1, 2, 3, 4, 5].map((n) => new ButtonBuilder().setCustomId(`cr:rate:${bookingId}:${n}`).setLabel(`${n} sao`).setStyle(ButtonStyle.Secondary))),
];
