import { SlashCommandBuilder } from "discord.js";
import { buyGiftCard, redeemGiftCard, unusedGiftCards } from "../domain/giftcards.js";
import { formatVnd } from "../domain/pricing.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { defer, respond } from "../discord/respond.js";

// Gift cards: pay from your wallet, get a code, give it to a friend; they enter it and the money lands in their wallet.

export default {
  data: new SlashCommandBuilder()
    .setName("quatang")
    .setDescription("Thẻ quà tặng: mua bằng tiền trong ví để tặng bạn bè, hoặc nhập mã bạn nhận được")
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("mua").setDescription("Mua một thẻ quà tặng bằng tiền trong ví").addIntegerOption((o) => o.setName("so-tien").setDescription("Số tiền VND").setRequired(true).setMinValue(1000)))
    .addSubcommand((s) => s.setName("nhap").setDescription("Nhập mã thẻ quà tặng để cộng tiền vào ví").addStringOption((o) => o.setName("ma").setDescription("Mã thẻ").setRequired(true).setMaxLength(20)))
    .addSubcommand((s) => s.setName("cua-toi").setDescription("Xem các thẻ bạn đã mua mà chưa ai dùng")),

  async execute(interaction) {
    await defer(interaction);
    const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "wallet");
    if (refusal) return respond(interaction, refusal);
    const sub = interaction.options.getSubcommand();
    if (sub === "mua") {
      const card = buyGiftCard(interaction.user.id, interaction.options.getInteger("so-tien"), now());
      return respond(interaction, `Đã mua thẻ quà tặng ${formatVnd(card.amountVnd)}. Mã thẻ: ${card.code}\nGửi mã này cho bạn bè, họ nhập bằng /quatang nhap. Ví của bạn còn ${formatVnd(card.balance)}.`);
    }
    if (sub === "nhap") {
      const done = redeemGiftCard(interaction.user.id, interaction.options.getString("ma"), now());
      return respond(interaction, `Đã cộng ${formatVnd(done.amountVnd)} vào ví của bạn. Số dư: ${formatVnd(done.balance)}.`);
    }
    const mine = unusedGiftCards(interaction.user.id);
    return respond(interaction, mine.length ? mine.map((c) => `${c.code} | ${formatVnd(c.amount_vnd)}`).join("\n") : "Bạn không có thẻ quà tặng nào chưa dùng.");
  },
};
