import { api, loadMe } from "./api.js";
import { h, $, clear, shell, avatar, fmtVnd, fmtWhen, durationText, countdown, statusPill, toast, confirmDialog, loginCard, ageGateCard, skeleton, showError } from "./ui.js";

const id = Number(new URLSearchParams(location.search).get("id"));
const view = $("#view");
let cfg;
let tick = null;
let poll = null;

function ticket(b) {
  const row = (label, value) => h("div", { class: "trow" }, h("dt", { text: label }), h("dd", { text: value }));
  return h("section", { class: "ticket", "aria-labelledby": "t-title" },
    h("div", { class: "ticket-top" }, avatar({ id: b.player.id, name: b.player.name }, { size: "md", photo: false }), h("div", {}, h("h2", { id: "t-title", text: b.player.name }), h("p", { class: "muted", text: `Lịch #${b.id}` })), statusPill(b.status)),
    h("dl", { class: "tlist" }, row("Game", b.game), row("Giờ hẹn", fmtWhen(b.startAt)), row("Thời lượng", durationText(b.durationMin)), b.discountVnd > 0 ? row(`Mã ${b.couponCode}`, `− ${fmtVnd(b.discountVnd)}`) : null),
    h("div", { class: "ticket-total" }, h("span", { text: "Tổng cộng" }), h("strong", { text: fmtVnd(b.priceVnd) })));
}

function unpaid(b, me) {
  const left = h("span", { class: "timer", role: "timer" });
  const message = h("p", { class: "warn-text", role: "alert" });
  const enough = me.wallet.balanceVnd >= b.priceVnd;
  const buttons = [];
  const lock = (on) => buttons.forEach((x) => (x.disabled = on));
  const wallet = h("button", { class: "btn btn-main btn-lg block-btn", type: "button", disabled: !enough, onclick: async () => {
    lock(true);
    try {
      await api(`bookings/${b.id}/pay-wallet`, { method: "POST", body: {} });
      toast("Đã thanh toán. Lịch của bạn đã được xác nhận.", "ok");
      await render();
    } catch (error) {
      message.textContent = error.message;
      lock(false);
    }
  } }, enough ? `Trả bằng ví (còn ${fmtVnd(me.wallet.balanceVnd - b.priceVnd)})` : "Ví không đủ");
  const link = h("button", { class: "btn btn-lg block-btn " + (enough ? "btn-quiet" : "btn-main"), type: "button", onclick: async () => {
    lock(true);
    message.textContent = "";
    try {
      const { payment } = await api(`bookings/${b.id}/pay-link`, { method: "POST", body: {} });
      if (!/^https:\/\//.test(payment.checkoutUrl)) throw new Error("Link thanh toán không hợp lệ.");
      location.assign(payment.checkoutUrl);
    } catch (error) {
      message.textContent = error.code === "payment_unavailable" ? "Thanh toán bằng link chưa mở. Bạn trả bằng ví hoặc quay lại sau nhé, lịch vẫn được giữ trong thời gian còn lại." : error.message;
      lock(false);
    }
  } }, cfg.payByLink ? "Chuyển khoản hoặc thẻ" : "Chuyển khoản hoặc thẻ (chưa mở)");
  const cancel = h("button", { class: "btn btn-quiet", type: "button", text: "Huỷ lịch này", onclick: () => cancelBooking(b) });
  buttons.push(wallet, link, cancel);

  const update = () => {
    const ms = b.expiresAt - Date.now();
    left.textContent = ms > 0 ? countdown(ms) : "00:00";
    if (ms <= 0) {
      clearInterval(tick);
      render();
    }
  };
  clearInterval(tick);
  tick = setInterval(update, 1000);
  update();
  return h("section", { class: "pay", "aria-labelledby": "pay-title" },
    h("h2", { id: "pay-title", text: "Thanh toán để giữ lịch" }),
    h("p", {}, "Lịch được giữ cho bạn thêm ", left, ". Hết giờ mà chưa trả, lịch tự huỷ."),
    h("p", { class: "muted", text: `Số dư ví của bạn: ${fmtVnd(me.wallet.balanceVnd)}` }),
    h("div", { class: "stack" }, wallet, link), message, h("div", { class: "row end" }, cancel));
}

async function cancelBooking(b) {
  const paid = b.status !== "AWAITING_PAYMENT";
  const ok = await confirmDialog({ title: `Huỷ lịch #${b.id}?`, body: paid ? (b.refund ? `Nếu huỷ bây giờ bạn được hoàn ${b.refund.percent}% (${fmtVnd(b.refund.vnd)}).` : "Lịch này không được hoàn tiền nếu huỷ bây giờ.") : "Lịch này chưa thanh toán nên huỷ không mất phí.", ok: "Huỷ lịch", cancel: "Giữ lịch", danger: true });
  if (!ok) return;
  try {
    await api(`bookings/${b.id}/cancel`, { method: "POST", body: {} });
    toast("Đã huỷ lịch.", "ok");
    await render();
  } catch (error) {
    toast(error.message, "error");
  }
}

function confirmed(b) {
  return h("section", { class: "pay done", "aria-labelledby": "ok-title" },
    h("h2", { id: "ok-title", text: b.status === "IN_PROGRESS" ? "Buổi hẹn đang diễn ra" : "Lịch đã được xác nhận" }),
    b.roomUrl
      ? h("div", { class: "stack" }, h("p", { text: "Phòng riêng của hai bạn đã mở trên Discord." }), h("a", { class: "btn btn-main btn-lg block-btn", href: b.roomUrl, rel: "noopener", text: "Vào phòng Discord" }))
      : h("p", { text: "Phòng chat và voice riêng trên Discord sẽ mở 10 phút trước giờ hẹn. Bot sẽ nhắn bạn khi phòng sẵn sàng." }),
    b.canCancel ? h("div", { class: "row end" }, h("button", { class: "btn btn-quiet", type: "button", text: "Huỷ lịch này", onclick: () => cancelBooking(b) })) : null,
    h("div", { class: "row" }, h("a", { class: "btn btn-quiet", href: "/bookings", text: "Lịch của tôi" })));
}

async function render() {
  clearInterval(tick);
  clearInterval(poll);
  const me = await loadMe(true);
  const b = me.bookings.find((x) => x.id === id);
  if (!b) return clear(view, h("div", { class: "notice" }, h("h1", { class: "h2", text: "Không thấy lịch này" }), h("p", { text: "Lịch có thể thuộc tài khoản khác hoặc đã quá cũ." }), h("a", { class: "btn btn-main", href: "/bookings", text: "Lịch của tôi" })));
  document.title = `Lịch #${b.id} | Chơi Cùng`;
  const body = b.status === "AWAITING_PAYMENT" ? unpaid(b, me) : ["CONFIRMED", "IN_PROGRESS"].includes(b.status) ? confirmed(b) : h("section", { class: "pay" }, h("h2", { text: b.status === "COMPLETED" ? "Buổi hẹn đã xong" : "Lịch này đã kết thúc" }), h("a", { class: "btn btn-main", href: "/bookings", text: "Lịch của tôi" }));
  clear(view, h("h1", { class: "h2", text: "Lịch của bạn" }), me.attested ? null : ageGateCard(cfg), h("div", { class: "split narrow" }, ticket(b), body));
  // a payment made in the other tab or through the link shows up here without a reload
  if (b.status === "AWAITING_PAYMENT") poll = setInterval(async () => {
    if (document.hidden) return;
    const fresh = await loadMe(true).catch(() => null);
    if (fresh?.bookings.find((x) => x.id === id)?.status !== "AWAITING_PAYMENT") render();
  }, 6000);
}

async function main() {
  clear(view, skeleton(2));

  ({ cfg } = await shell());
  if (!cfg.viewer) return clear(view, loginCard(cfg, "Đăng nhập để xem và thanh toán lịch của bạn."));
  await render();
}

main().catch((error) => showError(view, error));
