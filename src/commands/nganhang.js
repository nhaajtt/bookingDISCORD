import { SlashCommandBuilder } from "discord.js";
import { bankLine, getBank, removeBank, setBank } from "../domain/bank.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { limited } from "../discord/limits.js";
import { modal, rawField } from "../discord/modals.js";
import { defer, respond } from "../discord/respond.js";

// Where the owner sends your money: a player's payouts and a customer's refunds. Private to the person; only owners see it in the money queue.

async function openForm(interaction) {
  const current = getBank(interaction.user.id);
  return interaction.showModal(
    modal("bank:set", "Tài khoản nhận tiền", [
      { id: "bank", label: "Ngân hàng", max: 40, placeholder: "Vietcombank, MB, ACB, Techcombank...", value: current?.bank_name },
      { id: "number", label: "Số tài khoản", max: 24, value: current?.account_no },
      { id: "holder", label: "Tên chủ tài khoản", max: 50, placeholder: "NGUYEN VAN A", value: current?.account_name },
    ]),
  );
}

async function submitForm(interaction) {
  await defer(interaction);
  const refusal = gate(interaction, "user") ?? limited(interaction.user.id, "bank");
  if (refusal) return respond(interaction, refusal);
  const saved = setBank(interaction.user.id, { bank: rawField(interaction, "bank"), accountNo: rawField(interaction, "number"), accountName: rawField(interaction, "holder") }, now());
  return respond(interaction, `Đã lưu tài khoản nhận tiền: ${bankLine(saved)}. Chỉ chủ server thấy thông tin này khi chuyển tiền cho bạn.`);
}

export default {
  data: new SlashCommandBuilder()
    .setName("nganhang")
    .setDescription("Tài khoản ngân hàng để chủ server chuyển tiền cho bạn (trả công, hoàn tiền)")
    .setDMPermission(false)
    .addSubcommand((s) => s.setName("cap-nhat").setDescription("Nhập hoặc sửa tài khoản nhận tiền"))
    .addSubcommand((s) => s.setName("xem").setDescription("Xem tài khoản đã lưu"))
    .addSubcommand((s) => s.setName("xoa").setDescription("Xoá tài khoản đã lưu")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "cap-nhat") {
      const refusal = gate(interaction, "user");
      if (refusal) return respond(interaction, refusal);
      return openForm(interaction);
    }
    await defer(interaction);
    const refusal = gate(interaction, "user");
    if (refusal) return respond(interaction, refusal);
    if (sub === "xoa") return respond(interaction, removeBank(interaction.user.id) ? "Đã xoá tài khoản nhận tiền." : "Bạn chưa lưu tài khoản nào.");
    const bank = getBank(interaction.user.id);
    return respond(interaction, bank ? `Tài khoản của bạn: ${bankLine(bank)}` : "Bạn chưa lưu tài khoản nào. Dùng /nganhang cap-nhat.");
  },

  modals: { "bank:set": submitForm },
};
