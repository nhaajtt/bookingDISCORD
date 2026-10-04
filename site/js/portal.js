import { api } from "./api.js";
import { h, $, clear, shell, fmtVnd, fmtWhen, durationText, statusPill, toast, loginCard, emptyState, skeleton, showError, shortWeekday } from "./ui.js";

const view = $("#view");
let data;

const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const ORDER = [1, 2, 3, 4, 5, 6, 0];

// One bar per weekday, 24 hours wide, with a block for every range the player is free
function week(slots) {
  return h("div", { class: "week", role: "img", "aria-label": "Lịch rảnh hằng tuần" }, ORDER.map((d) => {
    const mine = slots.filter((s) => s.weekday === d);
    return h("div", { class: "wday" }, h("span", { class: "wday-name", text: shortWeekday(d) }), h("span", { class: "wbar" }, mine.map((s) => h("span", { class: "wblock", title: `${clock(s.startMin)}-${clock(s.endMin)}`, style: { "--from": `${(s.startMin / 1440) * 100}%`, "--span": `${((s.endMin - s.startMin) / 1440) * 100}%` } }))), h("span", { class: "wtext", text: mine.length ? mine.map((s) => `${clock(s.startMin)}-${clock(s.endMin)}`).join(", ") : "nghỉ" }));
  }));
}

function bookingRows(list, empty) {
  return list.length
    ? h("ul", { class: "blist" }, list.map((b) => h("li", { class: "brow" }, h("div", { class: "brow-main" }, h("p", { class: "brow-when", text: fmtWhen(b.startAt) }), h("p", { class: "muted", text: `${b.game}, ${durationText(b.durationMin)}, ${b.customer}` })), h("div", { class: "brow-side" }, statusPill(b.status), h("strong", { text: `+ ${fmtVnd(b.payoutVnd)}` })))))
    : emptyState(empty[0], empty[1]);
}

function draw() {
  const { player, availability, upcoming, recent, earnings } = data;
  const paused = player.status === "PAUSED";
  const area = h("textarea", { id: "hours", rows: 5, maxlength: 400, spellcheck: "false", "aria-describedby": "hours-help" });
  area.value = availability.text;
  const message = h("p", { class: "warn-text", role: "alert" });
  const preview = h("div", {}, week(availability.slots));
  const save = h("button", { class: "btn btn-main", type: "submit", text: "Lưu lịch rảnh" });
  const form = h("form", { class: "panel", onsubmit: async (e) => {
    e.preventDefault();
    message.textContent = "";
    save.disabled = true;
    try {
      const r = await api("me/availability", { method: "PUT", body: { text: area.value } });
      data.availability = r.availability;
      area.value = r.availability.text;
      clear(preview, week(r.availability.slots));
      toast("Đã lưu lịch rảnh.", "ok");
    } catch (error) {
      message.textContent = error.message;
    }
    save.disabled = false;
  } },
  h("label", { class: "field", for: "hours" }, h("span", { class: "label", text: "Giờ rảnh mỗi tuần" })), area,
  h("p", { id: "hours-help", class: "muted", text: "Viết từng ngày, cách nhau dấu chấm phẩy. Ví dụ: T2 19:00-23:00; T7 14:00-22:00; CN 09:00-12:00. Giờ tròn 30 phút. Rảnh qua nửa đêm thì tách thành hai ngày." }),
  message, preview, h("div", { class: "row end" }, save));

  const toggle = h("button", { class: `switch${paused ? "" : " on"}`, type: "button", role: "switch", "aria-checked": String(!paused), onclick: async () => {
    toggle.disabled = true;
    try {
      const r = await api("me/status", { method: "POST", body: { status: paused ? "ACTIVE" : "PAUSED" } });
      data.player.status = r.status;
      toast(r.status === "ACTIVE" ? "Bạn đang nhận lịch." : "Đã tạm nghỉ, khách sẽ không đặt được bạn.", "ok");
      draw();
    } catch (error) {
      toast(error.message, "error");
      toggle.disabled = false;
    }
  } }, h("span", { class: "knob", "aria-hidden": "true" }), h("span", { text: paused ? "Đang nghỉ" : "Đang nhận lịch" }));

  const stat = (label, value, note) => h("div", { class: "stat" }, h("dt", { text: label }), h("dd", { text: value }), note ? h("span", { class: "muted", text: note }) : null);
  clear(view,
    h("div", { class: "block-head" }, h("h1", { class: "h2", text: "Cổng player" }), toggle),
    h("dl", { class: "stats" }, stat("Sẵn sàng chuyển cho bạn", fmtVnd(earnings.releasableVnd), "Chủ server chuyển khoản"), stat("Chờ hết thời hạn khiếu nại", fmtVnd(earnings.heldVnd)), stat("Tổng chưa nhận", fmtVnd(earnings.owedVnd)), stat("Đã chơi", `${player.completed} buổi`, player.rating.count ? `${player.rating.average.toFixed(1)} sao` : "Chưa có đánh giá")),
    h("section", { class: "block", "aria-labelledby": "h-hours" }, h("h2", { id: "h-hours", class: "h3", text: "Lịch rảnh" }), form),
    h("section", { class: "block", "aria-labelledby": "h-up" }, h("h2", { id: "h-up", class: "h3", text: "Lịch sắp tới" }), bookingRows(upcoming, ["Chưa có lịch sắp tới", "Khi có khách đặt và thanh toán, lịch sẽ hiện ở đây."])),
    h("section", { class: "block", "aria-labelledby": "h-done" }, h("h2", { id: "h-done", class: "h3", text: "Mới hoàn thành" }), bookingRows(recent, ["Chưa có buổi nào xong", "Các buổi trong 14 ngày gần đây sẽ hiện ở đây."])));
}

async function main() {
  clear(view, skeleton(3));
  const { cfg } = await shell();
  if (!cfg.viewer) return clear(view, loginCard(cfg, "Đăng nhập bằng tài khoản Discord của player."));
  try {
    data = await api("me/player");
  } catch (error) {
    if (error.code === "NOT_A_PLAYER") return clear(view, h("div", { class: "notice" }, h("h1", { class: "h2", text: "Chỉ dành cho player" }), h("p", { text: "Tài khoản này chưa phải player. Muốn nhận lịch, bạn gửi hồ sơ trong server Discord." }), h("a", { class: "btn btn-main", href: "/", text: "Về trang chủ" })));
    throw error;
  }
  draw();
}

main().catch((error) => showError(view, error));
