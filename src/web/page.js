import { formatVnd } from "../domain/pricing.js";

// The owner's dashboard as one self-contained HTML page: no scripts, no external files, charts drawn as inline SVG. Every piece of
// text that came from the database goes through esc().

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STATUS_VI = {
  AWAITING_PAYMENT: "Chờ thanh toán",
  CONFIRMED: "Đã xác nhận",
  IN_PROGRESS: "Đang diễn ra",
  COMPLETED: "Hoàn thành",
  CANCELLED: "Đã huỷ",
  NO_SHOW_PLAYER: "Player vắng",
  NO_SHOW_CUSTOMER: "Khách vắng",
  DISPUTED: "Khiếu nại",
  EXPIRED: "Hết hạn",
};

// A bar chart: one bar per value, a label every few bars, the largest value written above the tallest bar
function bars(values, labels, { color = "var(--bar)", format = (v) => String(v) } = {}) {
  const width = 640;
  const height = 160;
  const pad = 22;
  const max = Math.max(1, ...values);
  const gap = 3;
  const w = (width - pad * 2) / Math.max(1, values.length) - gap;
  const step = Math.ceil(values.length / 8);
  const rects = values
    .map((v, i) => {
      const h = Math.round(((height - pad * 2) * v) / max);
      const x = pad + i * (w + gap);
      return `<rect x="${x.toFixed(1)}" y="${height - pad - h}" width="${w.toFixed(1)}" height="${Math.max(h, v > 0 ? 1 : 0)}" rx="2" fill="${color}"><title>${esc(labels[i])}: ${esc(format(v))}</title></rect>${i % step === 0 ? `<text x="${(x + w / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="axis">${esc(labels[i])}</text>` : ""}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="biểu đồ cột"><text x="${pad}" y="14" class="axis">${esc(format(max))}</text>${rects}</svg>`;
}

const stat = (label, value, note = "") => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
const pct = (v) => (v === null ? "chưa có" : `${v}%`);

export function renderDashboard(data, { title = "Bảng điều khiển" } = {}) {
  const t = data.totals;
  const l = data.ledger;
  const rows = (items, cells) => items.map((i) => `<tr>${cells(i).map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="4">Chưa có dữ liệu</td></tr>`;
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1b1f24;--muted:#5b6570;--line:#e3e6ea;--bar:#2f6fed;--bar2:#18a574;--bad:#c93c3c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#171c23;--text:#e8ebef;--muted:#9aa5b1;--line:#2a313a;--bar:#6b9bff;--bar2:#3dcf9b;--bad:#ff7b7b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--muted)}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.stat,.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.label{color:var(--muted);font-size:13px}.value{font-size:22px;font-weight:650}.note{color:var(--muted);font-size:12px}
svg{width:100%;height:auto;display:block}.axis{fill:var(--muted);font-size:10px}
table{width:100%;border-collapse:collapse}td,th{padding:7px 6px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}th{color:var(--muted);font-weight:500}
.two{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.bad{color:var(--bad)}
</style>
</head>
<body><main>
<h1>${esc(title)}</h1>
<div class="muted">${esc(data.days)} ngày gần nhất, múi giờ ${esc(data.zone)}, cập nhật ${esc(data.generatedText)}</div>

<h2>Tổng quan</h2>
<div class="grid">
${stat("Doanh thu (phí + phần player)", formatVnd(t.revenueVnd), `Phí giữ lại ${formatVnd(t.feeVnd)}`)}
${stat("Lịch hoàn thành", t.completed, `${t.bookings} lịch tổng cộng`)}
${stat("Tỉ lệ huỷ", pct(t.cancellationRate), `Khiếu nại ${pct(t.disputeRate)}`)}
${stat("Khách", t.customers, `${t.returningCustomers} khách quay lại`)}
${stat("Đánh giá trung bình", t.averageRating ?? "chưa có", `${t.ratings} lượt`)}
${stat("Player đang nhận lịch", data.players.active, `${data.players.paused} nghỉ, ${data.players.pending} chờ duyệt, ${data.players.suspended} bị khoá`)}
</div>

<h2>Theo ngày</h2>
<div class="two">
<div class="panel"><div class="label">Doanh thu mỗi ngày</div>${bars(data.daily.map((d) => d.revenueVnd), data.daily.map((d) => d.label), { format: formatVnd })}</div>
<div class="panel"><div class="label">Lịch hoàn thành mỗi ngày</div>${bars(data.daily.map((d) => d.completed), data.daily.map((d) => d.label), { color: "var(--bar2)" })}</div>
</div>

<h2>Đối soát tiền</h2>
<div class="grid">
${stat("Còn phải trả player", formatVnd(l.payoutsOwed.vnd), `${l.payoutsOwed.count} khoản`)}
${stat("Còn phải hoàn khách", formatVnd(l.refundsOwed.vnd), `${l.refundsOwed.count} khoản`)}
${stat("Đã trả player", formatVnd(l.payoutsPaid.vnd), `${l.payoutsPaid.count} khoản`)}
${stat("Đã hoàn khách", formatVnd(l.refundsPaid.vnd), `${l.refundsPaid.count} khoản`)}
${stat("Phí đã giữ lại", formatVnd(l.feeIncome.vnd))}
${stat("Ví khách còn lại", formatVnd(data.wallet.liabilityVnd), `${data.wallet.people} người, đã tặng thêm ${formatVnd(data.wallet.bonusGivenVnd)}`)}
</div>

<h2>Lịch theo trạng thái</h2>
<div class="panel"><table><tr><th>Trạng thái</th><th>Số lịch</th></tr>${rows(Object.entries(data.statuses), ([s, n]) => [STATUS_VI[s] ?? s, n])}</table></div>

<div class="two">
<div><h2>Player nổi bật</h2><div class="panel"><table><tr><th>Tên</th><th>Giờ</th><th>Buổi</th><th>Sao</th></tr>${rows(data.topPlayers, (p) => [p.name, p.hours, p.sessions, p.average ?? "-"])}</table></div></div>
<div><h2>Khách chi nhiều</h2><div class="panel"><table><tr><th>Mã người dùng</th><th>Đã chi</th><th>Buổi</th></tr>${rows(data.topCustomers, (c) => [c.userId, formatVnd(c.spentVnd), c.sessions])}</table></div></div>
</div>

<h2>Đơn thanh toán</h2>
<div class="panel"><table><tr><th>Trạng thái</th><th>Số đơn</th></tr>${rows(Object.entries(data.orders), ([s, n]) => [s, n])}</table></div>
</main></body></html>
`;
}
