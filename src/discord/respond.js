import { MessageFlags } from "discord.js";
import { DomainError } from "../domain/errors.js";
import { alert } from "../alerts.js";
import { log } from "../log.js";

// Nothing the bot sends may ping anyone unless the sender names the people on purpose
export const NO_MENTIONS = Object.freeze({ parse: [] });
export const mentionOnly = (...ids) => {
  const users = ids.filter(Boolean);
  return users.length ? { parse: [], users } : { parse: [] };
};

const asPayload = (payload) => (typeof payload === "string" ? { content: payload } : { ...payload });

// Replies (or edits the deferred reply) and is always private. Public posts go through channel.send, never through here.
export async function respond(interaction, payload) {
  const body = asPayload(payload);
  body.allowedMentions ??= NO_MENTIONS;
  if (interaction.deferred || interaction.replied) {
    delete body.flags;
    return interaction.editReply(body);
  }
  return interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
}

// A second private message after the first reply
export async function followUp(interaction, payload) {
  const body = asPayload(payload);
  body.allowedMentions ??= NO_MENTIONS;
  return interaction.followUp({ ...body, flags: MessageFlags.Ephemeral });
}

export async function defer(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

// Sends to a channel with mentions off unless named
export async function send(channel, payload, users = []) {
  const body = asPayload(payload);
  body.allowedMentions ??= mentionOnly(...users);
  return channel.send(body);
}

export const GENERIC_ERROR = "Có lỗi xảy ra, thử lại sau nhé.";

// DomainError -> its own Vietnamese message; anything else is logged, alerted and answered with the generic line
export async function failSoft(interaction, error, label = "interaction") {
  let text = GENERIC_ERROR;
  if (error instanceof DomainError) text = error.message;
  else {
    log.error("handler.failed", { label, error });
    alert(`Lỗi ${label}: ${error?.message ?? error}`);
  }
  try {
    await respond(interaction, text);
  } catch (inner) {
    log.error("handler.answer_failed", { label, error: inner });
  }
}

// True for Discord errors that will never succeed on retry: the channel, message or member is gone, or the person closed their DMs
const PERMANENT = new Set([10003, 10004, 10007, 10008, 10013, 50007]);
export const isGone = (error) => PERMANENT.has(error?.code);
