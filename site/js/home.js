import { api } from "./api.js";
import { h, $, clear, shell, avatar, stars, fmtK, fmtWhen, skeleton, emptyState, showError } from "./ui.js";

const state = { game: null, q: "", sort: "diem", free: false };
let cfg;

function card(p, { compact = false } = {}) {
  const from = Math.min(...p.games.map((g) => g.rateVnd));
  const soon = p.freeNow ? "Rảnh ngay" : p.nextFreeAt ? `Sớm nhất ${fmtWhen(p.nextFreeAt)}` : "Chưa có giờ trống";
  return h("a", { class: `pcard${compact ? " pcard-live" : ""}`, href: `/player?id=${encodeURIComponent(p.id)}` },
    h("span", { class: "pcard-art" }, avatar(p, { size: "lg" }), p.freeNow ? h("span", { class: "badge-now" }, h("span", { class: "dot-live", "aria-hidden": "true" }), "Rảnh ngay") : null),
    h("span", { class: "pcard-body" },
      h("span", { class: "pcard-name", text: p.name }),
      stars(p.rating.average, p.rating.count),
      h("span", { class: "tags" }, p.games.slice(0, compact ? 2 : 4).map((g) => h("span", { class: "tag", text: g.name }))),
      p.badges.length ? h("span", { class: "tags" }, p.badges.map((b) => h("span", { class: "tag tag-badge", text: b }))) : null,
      h("span", { class: "pcard-foot" }, h("span", { class: "price", text: `từ ${fmtK(from)}/giờ` }), h("span", { class: `when${p.freeNow ? " when-now" : ""}`, text: soon }))));
}

async function loadLive() {
  const row = $("#live-row");
  try {
    const { players } = await api("players?free=1&sort=diem");
    $("#live-note").textContent = players.length ? `${players.length} người sẵn sàng trong 30 phút tới` : "";
    clear(row, players.length ? players.map((p) => card(p, { compact: true })) : emptyState("Chưa ai rảnh lúc này", "Xem lịch sớm nhất của mọi người ở danh sách bên dưới và đặt trước một khung giờ.", h("a", { class: "btn btn-quiet", href: "#all", text: "Xem tất cả" })));
  } catch (error) {
    clear(row, h("p", { class: "muted", text: error.message }));
  }
}

let timer = null;
async function loadGrid() {
  const grid = $("#grid");
  const params = new URLSearchParams();
  if (state.game) params.set("game", state.game);
  if (state.q) params.set("q", state.q);
  if (state.free) params.set("free", "1");
  params.set("sort", state.sort);
  clear(grid, skeleton(6));
  try {
    const { players } = await api(`players?${params}`);
    $("#count").textContent = players.length ? `${players.length} người` : "";
    clear(grid, players.length ? players.map((p) => card(p)) : emptyState("Không tìm thấy ai", "Thử bỏ bớt bộ lọc hoặc đổi từ khoá khác.", h("button", { class: "btn btn-quiet", type: "button", text: "Xoá bộ lọc", onclick: reset })));
  } catch (error) {
    clear(grid, h("p", { class: "muted", text: error.message }));
  }
}

function drawChips() {
  const make = (name, label) => h("button", { class: "chip", type: "button", "aria-pressed": String(state.game === name), text: label, onclick: () => {
    state.game = name;
    drawChips();
    loadGrid();
  } });
  clear($("#chips"), make(null, "Tất cả"), cfg.games.map((g) => make(g.name, g.name)));
}

function reset() {
  Object.assign(state, { game: null, q: "", sort: "diem", free: false });
  $("#q").value = "";
  $("#sort").value = "diem";
  $("#free").checked = false;
  drawChips();
  loadGrid();
}

async function main() {
  const filters = $("#filters");
  filters.addEventListener("submit", (e) => e.preventDefault());
  $("#q").addEventListener("input", (e) => {
    state.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(loadGrid, 250);
  });
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    loadGrid();
  });
  $("#free").addEventListener("change", (e) => {
    state.free = e.target.checked;
    loadGrid();
  });
  const login = new URLSearchParams(location.search).get("login");
  ({ cfg } = await shell());
  if (login === "failed" || login === "cancelled") {
    const note = h("p", { class: "banner", role: "status", text: login === "failed" ? "Đăng nhập chưa thành công. Bạn thử lại nhé." : "Bạn đã huỷ đăng nhập." });
    $("#main").prepend(note);
  }
  drawChips();
  await Promise.all([loadLive(), loadGrid()]);
  // keep "đang rảnh" honest while the page stays open
  setInterval(() => {
    if (!document.hidden) loadLive();
  }, 60_000);
}

main().catch((error) => showError($("#main"), error));
