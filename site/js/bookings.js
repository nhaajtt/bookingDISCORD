import { api, loadMe } from "./api.js";
import { h, $, clear, shell, avatar, fmtVnd, fmtWhen, durationText, statusPill, toast, confirmDialog, loginCard, ageGateCard, emptyState, skeleton, showError } from "./ui.js";

const view = $("#view");
let cfg;
let me;
let tab = "up";

const UPCOMING = ["AWAITING_PAYMENT", "CONFIRMED", "IN_PROGRESS"];

async function cancel(b) {
  const paid = b.status !== "AWAITING_PAYMENT";
  const ok = await confirmDialog({ title: `Huỷ lịch #${b.id}?`, body: paid ? (b.refund && b.refund.vnd > 0 ? `Nếu huỷ bây giờ bạn được hoàn ${b.refund.percent}% (${fmtVnd(b.refund.vnd)}).` : "Lịch này không được hoàn tiền nếu huỷ bây giờ.") : "Lịch này chưa thanh toán nên huỷ không mất phí.", ok: "Huỷ lịch", cancel: "Giữ lịch", danger: true });
  if (!ok) return;
  try {
    const r = await api(`bookings/${b.id}/cancel`, { method: "POST", body: {} });
    toast(r.refundVnd > 0 ? `Đã huỷ lịch. Khoản hoàn ${fmtVnd(r.refundVnd)} đã được ghi nhận.` : "Đã huỷ lịch.", "ok");
    await reload();
  } catch (error) {
    toast(error.message, "error");
  }
}

function rate(b) {
  let stars = 0;
  const message = h("p", { class: "warn-text", role: "alert" });
  const review = h("textarea", { id: "review", rows: 3, maxlength: 300, placeholder: "Bạn thấy buổi hẹn thế nào? (không bắt buộc)" });
  const group = h("div", { class: "starpick", role: "radiogroup", "aria-label": "Số sao" }, [1, 2, 3, 4, 5].map((n) => h("button", { class: "starbtn", type: "button", role: "radio", "aria-checked": "false", "aria-label": `${n} sao`, text: "★", onclick: (e) => {
    stars = n;
    [...group.children].forEach((x, i) => {
      x.setAttribute("aria-checked", String(i + 1 === n));
      x.classList.toggle("on", i < n);
    });
    e.currentTarget.focus();
  } })));
  const dialog = h("dialog", { class: "dialog", "aria-labelledby": "rate-title" },
    h("h2", { id: "rate-title", text: `Đánh giá ${b.player.name}` }), group,
    h("label", { class: "field" }, h("span", { class: "label", text: "Nhận xét" }), review), message,
    h("div", { class: "row end" }, h("button", { class: "btn btn-quiet", type: "button", text: "Để sau", onclick: () => dialog.close() }), h("button", { class: "btn btn-main", type: "button", text: "Gửi đánh giá", onclick: async (e) => {
      if (!stars) return (message.textContent = "Chọn số sao trước nhé.");
      e.currentTarget.disabled = true;
      try {
        await api(`bookings/${b.id}/rate`, { method: "POST", body: { stars, review: review.value } });
        dialog.close();
        toast("Cảm ơn bạn đã đánh giá!", "ok");
        await reload();
      } catch (error) {
        message.textContent = error.message;
        e.currentTarget.disabled = false;
      }
    } })));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function row(b) {
  return h("li", { class: "brow" },
    avatar({ id: b.player.id, name: b.player.name }, { size: "md", photo: false }),
    h("div", { class: "brow-main" },
      h("a", { class: "brow-title", href: `/player?id=${encodeURIComponent(b.player.id)}`, text: b.player.name }),
      h("p", { class: "muted", text: `${b.game}, ${durationText(b.durationMin)}` }),
      h("p", { class: "brow-when", text: fmtWhen(b.startAt) })),
    h("div", { class: "brow-side" },
      statusPill(b.status), h("strong", { text: fmtVnd(b.priceVnd) }),
      h("div", { class: "row end" },
        b.status === "AWAITING_PAYMENT" ? h("a", { class: "btn btn-main btn-sm", href: `/booking?id=${b.id}`, text: "Thanh toán" }) : null,
        ["CONFIRMED", "IN_PROGRESS"].includes(b.status) ? h("a", { class: "btn btn-quiet btn-sm", href: `/booking?id=${b.id}`, text: b.roomUrl ? "Vào phòng" : "Chi tiết" }) : null,
        b.canCancel ? h("button", { class: "btn btn-quiet btn-sm", type: "button", text: "Huỷ", onclick: () => cancel(b) }) : null,
        b.canRate ? h("button", { class: "btn btn-main btn-sm", type: "button", text: "Đánh giá", onclick: () => rate(b) }) : null,
        b.status === "COMPLETED" && b.rating ? h("span", { class: "muted", text: `Bạn chấm ${b.rating} sao` }) : null,
        ["COMPLETED", "CANCELLED", "EXPIRED"].includes(b.status) ? h("a", { class: "btn btn-quiet btn-sm", href: `/player?id=${encodeURIComponent(b.player.id)}`, text: "Đặt lại" }) : null)));
}

function draw() {
  const upcoming = me.bookings.filter((b) => UPCOMING.includes(b.status)).sort((a, b) => a.startAt - b.startAt);
  const past = me.bookings.filter((b) => !UPCOMING.includes(b.status));
  const list = tab === "up" ? upcoming : past;
  const tabBtn = (key, label, n) => h("button", { class: "tabbtn", type: "button", role: "tab", "aria-selected": String(tab === key), onclick: () => {
    tab = key;
    draw();
  } }, label, h("span", { class: "count", text: String(n) }));
  clear(view,
    h("div", { class: "block-head" }, h("h1", { class: "h2", text: "Lịch của tôi" }), h("p", { class: "wallet-chip" }, "Ví ", h("strong", { text: fmtVnd(me.wallet.balanceVnd) }))),
    me.attested ? null : ageGateCard(cfg),
    h("div", { class: "tablist", role: "tablist" }, tabBtn("up", "Sắp tới", upcoming.length), tabBtn("past", "Đã qua", past.length)),
    h("div", { role: "tabpanel" }, list.length ? h("ul", { class: "blist" }, list.map(row)) : tab === "up" ? emptyState("Chưa có lịch nào sắp tới", "Chọn một người bạn đang rảnh và đặt giờ đầu tiên.", h("a", { class: "btn btn-main", href: "/", text: "Tìm người chơi" })) : emptyState("Chưa có lịch nào đã qua", "Các buổi đã xong hoặc đã huỷ sẽ nằm ở đây.")),
    me.waitlist.length ? h("section", { class: "block", "aria-labelledby": "wl" }, h("h2", { id: "wl", class: "h3", text: "Đang chờ chỗ trống" }), h("ul", { class: "blist" }, me.waitlist.map((w) => h("li", { class: "brow" }, avatar({ id: w.playerId, name: w.playerName }, { size: "md", photo: false }), h("div", { class: "brow-main" }, h("a", { class: "brow-title", href: `/player?id=${encodeURIComponent(w.playerId)}`, text: w.playerName }), h("p", { class: "muted", text: `${w.game}, ${durationText(w.durationMin)}` }), h("p", { class: "brow-when", text: fmtWhen(w.startAt) })), h("div", { class: "brow-side" }, h("span", { class: `pill ${w.notified ? "pill-ok" : "pill-warn"}`, text: w.notified ? "Đã có chỗ, đặt ngay" : "Đang chờ" }), w.notified ? h("a", { class: "btn btn-main btn-sm", href: `/player?id=${encodeURIComponent(w.playerId)}`, text: "Đặt lịch" }) : null))))) : null);
}

async function reload() {
  me = await loadMe(true);
  draw();
}

async function main() {
  clear(view, skeleton(3));
  ({ cfg } = await shell());
  if (!cfg.viewer) return clear(view, loginCard(cfg, "Đăng nhập để xem lịch của bạn."));
  me = await loadMe(true);
  draw();
}

main().catch((error) => showError(view, error));
