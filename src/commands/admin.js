import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { backupDb } from "../backup.js";
import { listAudit } from "../audit.js";
import { adjustWallet } from "../domain/wallet.js";
import { dashboardToken } from "../web/auth.js";
import { licenseStatus } from "../license.js";
import { savePaymentKeys, paymentKeys } from "../pay/credentials.js";
import { enabledProviders, PROVIDERS } from "../pay/gateway.js";
import { config } from "../config.js";
import { MEMBERSHIP_EXAMPLE, PACKAGE_EXAMPLE, PEAK_EXAMPLE, formatMemberships, formatPeaks, parseMemberships, parsePackages, parsePeaks } from "../domain/quoting.js";
import { getSettings, patchSettings } from "../settings.js";
import { RECEIVER, receivingAccount } from "../pay/manual.js";
import { bankLine, setBank } from "../domain/bank.js";
import { confirmRow, pendingTransfers, transferEmbed } from "../flows/manualpay.js";
import { recentOrders } from "../pay/orders.js";
import { formatVnd } from "../domain/pricing.js";
import { formatLocal } from "../domain/time.js";
import { gate } from "../discord/access.js";
import { now } from "../discord/clock.js";
import { mention, nameOf } from "../discord/guild.js";
import { field, modal, parseVnd, rawField } from "../discord/modals.js";
import { audit } from "../discord/moderation.js";
import { defer, respond } from "../discord/respond.js";
import { COLORS, cancellationLines } from "../discord/text.js";

// Owner-only settings and tools. Every value goes through normalizeSettings, which clamps it, and the answer shows what was really stored.

const GROUPS = {
  phi: {
    title: "Phí và giới hạn",
    fields: [
      { id: "feePercent", label: "Phí nền tảng (%)", key: "feePercent" },
      { id: "maxDurationHours", label: "Thời lượng tối đa (giờ)", key: "maxDurationHours" },
      { id: "maxActiveBookings", label: "Số lịch cùng lúc của một khách", key: "maxActiveBookings" },
      { id: "minRateVnd", label: "Giá thấp nhất của player (VND/giờ)", key: "minRateVnd" },
      { id: "maxRateVnd", label: "Giá cao nhất của player (VND/giờ)", key: "maxRateVnd" },
    ],
  },
  thoigian: {
    title: "Thời gian",
    fields: [
      { id: "minLeadMin", label: "Đặt trước tối thiểu (phút)", key: "minLeadMin" },
      { id: "maxAdvanceDays", label: "Đặt trước tối đa (ngày)", key: "maxAdvanceDays" },
      { id: "unpaidExpireMin", label: "Thời gian chờ thanh toán (phút)", key: "unpaidExpireMin" },
      { id: "noShowGraceMin", label: "Chờ trước khi tính vắng mặt (phút)", key: "noShowGraceMin" },
      { id: "reviewWindowHours", label: "Thời gian đánh giá và khiếu nại (giờ)", key: "reviewWindowHours" },
    ],
  },
};

GROUPS.gioithieu = {
  title: "Giới thiệu bạn bè",
  fields: [
    { id: "rewardVnd", label: "Thưởng mỗi bên (VND, 0 = tắt)", key: "referral.rewardVnd" },
    { id: "minPriceVnd", label: "Buổi đầu tối thiểu để được thưởng (VND)", key: "referral.minPriceVnd" },
  ],
};

GROUPS.tienich = {
  title: "Tiện ích",
  fields: [
    { id: "maxExtendMin", label: "Gia hạn tối đa trong phòng (phút, 0 = tắt)", key: "maxExtendMin" },
    { id: "waitlistHoldMin", label: "Giữ chỗ cho người chờ (phút)", key: "waitlistHoldMin" },
    { id: "maxSeriesWeeks", label: "Đặt lặp hằng tuần tối đa (tuần, 0 = tắt)", key: "maxSeriesWeeks" },
    { id: "earnPerVnd", label: "Mỗi bao nhiêu VND chi được 1 điểm (0 = tắt)", key: "loyalty.earnPerVnd" },
    { id: "pointValueVnd", label: "Giá trị 1 điểm khi đổi (VND)", key: "loyalty.pointValueVnd" },
  ],
};

const readKey = (settings, key) => key.split(".").reduce((o, k) => o?.[k], settings);

export const CANCEL_EXAMPLE = "Mỗi dòng một mức: số giờ trước giờ hẹn, rồi phần trăm hoàn. Ví dụ:\n24h 100\n2h 50\n0h 0";

// "24h 100" lines -> tiers, or { error }
export function parseTiers(text) {
  const tiers = [];
  for (const line of String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d{1,3})\s*h?\s+(\d{1,3})\s*%?$/i.exec(line);
    if (!m) return { error: `Dòng "${line.slice(0, 40)}" chưa đúng. ${CANCEL_EXAMPLE}` };
    tiers.push({ minHoursBefore: Number(m[1]), refundPercent: Number(m[2]) });
  }
  if (!tiers.length) return { error: `Chưa có mức nào. ${CANCEL_EXAMPLE}` };
  return { tiers };
}

async function openSettings(interaction) {
  const group = interaction.options.getString("nhom");
  const settings = getSettings();
  if (group === "huy") {
    return interaction.showModal(
      modal("ad:settings:huy", "Chính sách huỷ và ghi chú", [
        { id: "cancellation", label: "Mức hoàn khi khách huỷ", max: 100, paragraph: true, value: settings.cancellation.map((t) => `${t.minHoursBefore}h ${t.refundPercent}`).join("\n") },
        { id: "ownerNotes", label: "Ghi chú hiện cạnh danh sách chuyển tiền", max: 1000, paragraph: true, required: false, value: settings.ownerNotes },
      ]),
    );
  }
  if (group === "caodiem") {
    return interaction.showModal(modal("ad:settings:caodiem", "Giá cao điểm", [{ id: "peaks", label: "Các khung giờ cao điểm (để trống để tắt)", max: 400, paragraph: true, required: false, placeholder: PEAK_EXAMPLE, value: formatPeaks(settings.peaks) }]));
  }
  if (group === "giovang") {
    return interaction.showModal(modal("ad:settings:giovang", "Giảm giá giờ vắng khách", [{ id: "offpeak", label: "Các khung giờ giảm (để trống để tắt)", max: 300, paragraph: true, required: false, placeholder: PEAK_EXAMPLE.replace("tăng", "giảm"), value: formatPeaks(settings.offpeak) }]));
  }
  if (group === "thanhvien") {
    return interaction.showModal(modal("ad:settings:thanhvien", "Gói thành viên", [{ id: "memberships", label: "Các gói (để trống để tắt)", max: 300, paragraph: true, required: false, placeholder: MEMBERSHIP_EXAMPLE, value: formatMemberships(settings.memberships) }]));
  }
  if (group === "goinap") {
    return interaction.showModal(modal("ad:settings:goinap", "Gói nạp ví", [{ id: "packages", label: "Các gói nạp", max: 200, paragraph: true, placeholder: PACKAGE_EXAMPLE, value: settings.packages.map((p) => `${p.amountVnd} +${p.bonusPercent}`).join("\n") }]));
  }
  const def = GROUPS[group];
  return interaction.showModal(modal(`ad:settings:${group}`, def.title, def.fields.map((f) => ({ id: f.id, label: f.label, max: 9, value: readKey(settings, f.key) }))));
}

async function submitSettings(interaction, [group]) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const patch = {};
  if (group === "huy") {
    const parsed = parseTiers(rawField(interaction, "cancellation"));
    if (parsed.error) return respond(interaction, parsed.error);
    patch.cancellation = parsed.tiers;
    patch.ownerNotes = field(interaction, "ownerNotes", 1000);
  } else if (group === "caodiem") {
    const parsed = parsePeaks(rawField(interaction, "peaks"));
    if (parsed.error) return respond(interaction, parsed.error);
    patch.peaks = parsed.peaks;
  } else if (group === "giovang") {
    const parsed = parsePeaks(rawField(interaction, "offpeak"));
    if (parsed.error) return respond(interaction, parsed.error);
    patch.offpeak = parsed.peaks;
  } else if (group === "thanhvien") {
    const parsed = parseMemberships(rawField(interaction, "memberships"), parseVnd);
    if (parsed.error) return respond(interaction, parsed.error);
    patch.memberships = parsed.memberships;
  } else if (group === "goinap") {
    const parsed = parsePackages(rawField(interaction, "packages"), parseVnd);
    if (parsed.error) return respond(interaction, parsed.error);
    patch.packages = parsed.packages;
  } else {
    const def = GROUPS[group];
    if (!def) return respond(interaction, "Nhóm cài đặt không hợp lệ.");
    const current = getSettings();
    for (const f of def.fields) {
      const n = Number(rawField(interaction, f.id).replace(/[.,\s]/g, ""));
      if (!Number.isInteger(n)) return respond(interaction, `Giá trị của "${f.label}" phải là số nguyên.`);
      const [head, tail] = f.key.split(".");
      if (tail) patch[head] = { ...(patch[head] ?? current[head]), [tail]: n };
      else patch[head] = n;
    }
  }
  const saved = patchSettings(patch, now());
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} đổi cài đặt (${group}).`);
  const lines =
    group === "huy"
      ? [...cancellationLines(saved.cancellation), saved.ownerNotes ? `Ghi chú: ${saved.ownerNotes}` : "Chưa có ghi chú."]
      : group === "caodiem"
        ? saved.peaks.length ? formatPeaks(saved.peaks).split("\n") : ["Không có giá cao điểm."]
        : group === "giovang"
          ? saved.offpeak.length ? formatPeaks(saved.offpeak).split(/\n/).map((l) => l.replace(" +", " giảm ")) : ["Không có giảm giá giờ vắng."]
          : group === "thanhvien"
            ? saved.memberships.length ? saved.memberships.map((m) => `${m.name}: ${formatVnd(m.priceVnd)} / ${m.days} ngày, giảm ${m.discountPercent}%`) : ["Không có gói thành viên."]
            : group === "goinap"
          ? saved.packages.map((p) => `Nạp ${formatVnd(p.amountVnd)}, tặng thêm ${p.bonusPercent}%`)
          : GROUPS[group].fields.map((f) => `${f.label}: ${readKey(saved, f.key)}`);
  return respond(interaction, { embeds: [new EmbedBuilder().setColor(COLORS.ok).setTitle("Đã lưu cài đặt").setDescription(`${lines.join("\n")}\n\nLịch đã tạo giữ nguyên giá và phí cũ; cài đặt mới áp dụng cho lịch mới.`)] });
}

async function openReceiving(interaction) {
  const have = receivingAccount();
  return interaction.showModal(
    modal("ad:receive", "Tài khoản nhận tiền", [
      { id: "bank", label: "Ngân hàng (ví dụ MB, Vietcombank, Techcombank)", max: 40, value: have?.bank_name ?? "" },
      { id: "accountNo", label: "Số tài khoản", max: 20, value: have?.account_no ?? "" },
      { id: "accountName", label: "Tên chủ tài khoản (như trên thẻ)", max: 50, value: have?.account_name ?? "" },
    ]),
  );
}

async function submitReceiving(interaction) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  const saved = setBank(RECEIVER, { bank: rawField(interaction, "bank"), accountNo: rawField(interaction, "accountNo"), accountName: rawField(interaction, "accountName") }, now());
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} đổi tài khoản nhận tiền.`);
  return respond(interaction, `Đã lưu tài khoản nhận tiền: ${bankLine(saved)}. Từ giờ khách chọn thanh toán sẽ chuyển khoản vào tài khoản này, bạn bấm Đã nhận tiền khi thấy tiền về.`);
}

async function choXacNhan(interaction) {
  const rows = pendingTransfers(now()).slice(0, 5);
  if (!rows.length) return respond(interaction, "Không có khoản chuyển khoản nào đang chờ xác nhận.");
  return respond(interaction, { embeds: rows.map((o) => transferEmbed(o)), components: rows.map((o) => confirmRow(o)) });
}

async function backup(interaction) {
  const file = backupDb(new Date(now()));
  return respond(interaction, file ? `Đã sao lưu: ${file.split(/[\\/]/).pop()}` : "Hôm nay đã có bản sao lưu.");
}

async function donhang(interaction) {
  const rows = recentOrders(10);
  if (!rows.length) return respond(interaction, "Chưa có đơn thanh toán nào.");
  const zone = getSettings().timezone;
  const lines = rows.map((o) => `#${o.order_code} | lịch #${o.booking_id} | ${mention(o.user_id)} | ${formatVnd(o.amount)} | ${o.status} | ${formatLocal(o.created_at, zone)}`);
  return respond(interaction, { embeds: [new EmbedBuilder().setColor(COLORS.money).setTitle("Đơn thanh toán gần đây").setDescription(lines.join("\n"))] });
}

function giayPhep(interaction) {
  if (!config.multiTenant) return respond(interaction, "Bot đang chạy ở chế độ một server nên không cần giấy phép.");
  const s = licenseStatus(interaction.guildId, now());
  const zone = getSettings().timezone;
  if (s.state === "none") return respond(interaction, s.reason);
  return respond(interaction, `Gói ${s.plan}, ${s.state === "active" ? `còn ${s.daysLeft} ngày` : s.state === "grace" ? "đã hết hạn, đang ân hạn" : "đã hết hạn"} (đến ${formatLocal(s.expiresAt, zone)}). Gia hạn bằng /kichhoat với mã mới.`);
}

const KEY_FIELDS = [
  { id: "payosClient", label: "payOS Client ID", path: ["payos", "clientId"] },
  { id: "payosKey", label: "payOS API Key", path: ["payos", "apiKey"] },
  { id: "payosChecksum", label: "payOS Checksum Key", path: ["payos", "checksumKey"] },
  { id: "stripeKey", label: "Stripe Secret Key (sk_...)", path: ["stripe", "secretKey"] },
  { id: "returnUrl", label: "Trang khách quay về sau khi trả", path: ["returnUrl"] },
];

async function openKeys(interaction) {
  if (!config.multiTenant) return respond(interaction, "Bot đang chạy ở chế độ một server: khoá thanh toán nằm trong file cấu hình trên máy chủ (PAYOS_*, STRIPE_SECRET_KEY), không nhập qua Discord.");
  const provider = interaction.options.getString("cong-mac-dinh") ?? "auto";
  return interaction.showModal(
    modal(`ad:keys:${provider}`, "Khoá thanh toán", KEY_FIELDS.map((f) => ({ id: f.id, label: f.label, max: f.id === "returnUrl" ? 200 : 120, required: false, placeholder: "Để trống = giữ nguyên, gõ - để xoá" }))),
  );
}

async function submitKeys(interaction, [provider]) {
  const refusal = gate(interaction, "owner");
  if (refusal) return respond(interaction, refusal);
  await defer(interaction);
  if (!config.multiTenant) return respond(interaction, "Chức năng này chỉ dùng ở chế độ nhiều server.");
  const patch = { payos: {}, stripe: {} };
  for (const f of KEY_FIELDS) {
    const value = rawField(interaction, f.id);
    if (!value) continue;
    const next = value === "-" ? null : value;
    if (f.path.length === 2) patch[f.path[0]][f.path[1]] = next;
    else patch[f.path[0]] = next;
  }
  patch.provider = provider === "auto" ? null : provider;
  savePaymentKeys(patch);
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} cập nhật khoá thanh toán.`);
  const on = enabledProviders().map((p) => PROVIDERS[p].name);
  return respond(interaction, `Đã lưu. Cổng đang bật: ${on.length ? on.join(", ") : "chưa có (cần đủ ba khoá payOS, hoặc khoá Stripe)"}. Cổng mặc định: ${paymentKeys().provider ?? "tự chọn"}.`);
}

async function bangDieuKhien(interaction) {
  if (!config.web.port) return respond(interaction, "Máy chủ web đang tắt. Đặt WEB_PORT trong cấu hình rồi khởi động lại bot để dùng bảng điều khiển.");
  const token = dashboardToken({ rotate: Boolean(interaction.options.getBoolean("tao-lai-ma")) });
  const base = config.web.publicUrl ?? `http://<địa-chỉ-máy>:${config.web.port}`;
  const where = config.multiTenant ? `/${interaction.guildId}` : "";
  return respond(interaction, `Bảng điều khiển: ${base}/dashboard${where}?token=${token}\nChỉ bạn thấy tin này. Ai có địa chỉ này đều xem được số liệu, đừng chia sẻ. Đổi mã bằng /admin bang-dieu-khien tao-lai-ma:true.\nWebhook payOS (nếu muốn nhận tiền nhanh hơn): ${base}/webhook/payos${where}`);
}

async function dieuChinhVi(interaction) {
  const target = interaction.options.getUser("user");
  const amount = interaction.options.getInteger("so-tien");
  const balance = adjustWallet(target.id, amount, interaction.options.getString("ly-do"), now());
  await audit(interaction.guild, `${nameOf(interaction.member ?? interaction.user)} điều chỉnh ví ${mention(target.id)}: ${amount > 0 ? "+" : ""}${formatVnd(amount)}.`);
  return respond(interaction, `Đã điều chỉnh ví ${mention(target.id)} ${amount > 0 ? "+" : ""}${formatVnd(amount)}. Số dư mới: ${formatVnd(balance)}.`);
}

async function nhatKy(interaction) {
  const zone = getSettings().timezone;
  const rows = listAudit({ limit: interaction.options.getInteger("so-dong") ?? 20, actorId: interaction.options.getUser("user")?.id ?? null });
  if (!rows.length) return respond(interaction, "Chưa có dòng nào trong nhật ký.");
  const lines = rows.map((r) => `${formatLocal(r.at, zone)} | ${r.actor_id ? mention(r.actor_id) : "hệ thống"} | ${r.action}${r.detail ? ` ${r.detail}` : ""}`);
  return respond(interaction, { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle("Nhật ký thao tác").setDescription(lines.join("\n").slice(0, 3900))] });
}

export default {
  audited: true,
  auditedPrefixes: ["ad"],
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Cài đặt và công cụ cho chủ server")
    .setDefaultMemberPermissions(0)
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("cai-dat")
        .setDescription("Sửa phí, giới hạn, thời gian, chính sách huỷ")
        .addStringOption((o) =>
          o.setName("nhom").setDescription("Nhóm cài đặt").setRequired(true).addChoices({ name: "Phí và giới hạn", value: "phi" }, { name: "Thời gian", value: "thoigian" }, { name: "Chính sách huỷ và ghi chú", value: "huy" }, { name: "Giá cao điểm", value: "caodiem" }, { name: "Gói nạp ví", value: "goinap" }, { name: "Giảm giá giờ vắng", value: "giovang" }, { name: "Gói thành viên", value: "thanhvien" }, { name: "Giới thiệu bạn bè", value: "gioithieu" }, { name: "Tiện ích (gia hạn, chờ, lặp, điểm)", value: "tienich" }),
        ),
    )
    .addSubcommand((s) => s.setName("nhan-tien").setDescription("Đặt tài khoản ngân hàng nhận tiền khách chuyển khoản"))
    .addSubcommand((s) => s.setName("cho-xac-nhan").setDescription("Các khoản khách chuyển khoản đang chờ bạn xác nhận"))
    .addSubcommand((s) => s.setName("sao-luu").setDescription("Sao lưu cơ sở dữ liệu ngay"))
    .addSubcommand((s) => s.setName("donhang").setDescription("10 đơn thanh toán gần nhất"))
    .addSubcommand((s) => s.setName("giay-phep").setDescription("Xem giấy phép sử dụng của server này"))
    .addSubcommand((s) =>
      s
        .setName("thanh-toan")
        .setDescription("Nhập khoá cổng thanh toán của server này (payOS, Stripe)")
        .addStringOption((o) =>
          o.setName("cong-mac-dinh").setDescription("Cổng dùng cho thanh toán mới").addChoices({ name: "Tự chọn (payOS trước)", value: "auto" }, { name: "payOS", value: "payos" }, { name: "Stripe", value: "stripe" }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("bang-dieu-khien")
        .setDescription("Xem địa chỉ và mã truy cập của bảng điều khiển trên web")
        .addBooleanOption((o) => o.setName("tao-lai-ma").setDescription("Đổi mã truy cập, mã cũ không dùng được nữa")),
    )
    .addSubcommand((s) =>
      s
        .setName("dieu-chinh-vi")
        .setDescription("Cộng hoặc trừ tiền trong ví của một khách (khi hoàn tiền mặt, sửa nhầm)")
        .addUserOption((o) => o.setName("user").setDescription("Khách").setRequired(true))
        .addIntegerOption((o) => o.setName("so-tien").setDescription("Số tiền VND, âm để trừ").setRequired(true))
        .addStringOption((o) => o.setName("ly-do").setDescription("Lý do").setRequired(true).setMaxLength(100)),
    )
    .addSubcommand((s) =>
      s
        .setName("nhat-ky")
        .setDescription("Ai đã dùng lệnh hoặc nút của nhân viên và chủ server")
        .addUserOption((o) => o.setName("user").setDescription("Chỉ xem một người"))
        .addIntegerOption((o) => o.setName("so-dong").setDescription("Số dòng (mặc định 20)").setMinValue(1).setMaxValue(50)),
    ),

  async execute(interaction) {
    const refusal = gate(interaction, "owner");
    if (refusal) return respond(interaction, refusal);
    const sub = interaction.options.getSubcommand();
    if (sub === "cai-dat") return openSettings(interaction);
    if (sub === "thanh-toan") return openKeys(interaction);
    if (sub === "nhan-tien") return openReceiving(interaction);
    await defer(interaction);
    if (sub === "cho-xac-nhan") return choXacNhan(interaction);
    if (sub === "nhat-ky") return nhatKy(interaction);
    if (sub === "dieu-chinh-vi") return dieuChinhVi(interaction);
    if (sub === "bang-dieu-khien") return bangDieuKhien(interaction);
    if (sub === "giay-phep") return giayPhep(interaction);
    return sub === "sao-luu" ? backup(interaction) : donhang(interaction);
  },

  modals: { "ad:settings": submitSettings, "ad:keys": submitKeys, "ad:receive": submitReceiving },
};
