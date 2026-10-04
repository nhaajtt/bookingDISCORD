import { loadConfig, loadMe, api, forgetMe } from "./api.js";

export const SITE_NAME = "Chơi Cùng";

// ---------------------------------------------------------------- building elements (text is always set as text, never as HTML)

const SVG = "http://www.w3.org/2000/svg";

export function h(tag, props = {}, ...kids) {
  const node = tag.startsWith("svg:") ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.setAttribute("class", value);
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "style") for (const [k, v] of Object.entries(value)) node.style.setProperty(k, v);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, kids);
  return node;
}
function append(node, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}
export const clear = (node, ...kids) => {
  node.replaceChildren();
  append(node, kids);
  return node;
};
export const $ = (selector, root = document) => root.querySelector(selector);

// ---------------------------------------------------------------- formatting

export const fmtVnd = (n) => `${Math.round(n).toLocaleString("vi-VN")} đ`;
export const fmtK = (n) => (n % 1000 === 0 ? `${n / 1000}k` : fmtVnd(n));

let zone = "Asia/Ho_Chi_Minh";
export const setZone = (z) => {
  zone = z || zone;
};
const DAYS = { Sun: "CN", Mon: "T2", Tue: "T3", Wed: "T4", Thu: "T5", Fri: "T6", Sat: "T7" };
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
export const fmtTime = (ms) => {
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
};
export const fmtDay = (ms) => {
  const p = parts(ms);
  return `${DAYS[p.weekday]} ${p.day}/${p.month}`;
};
export const fmtWhen = (ms) => `${fmtDay(ms)}, ${fmtTime(ms)}`;
export const weekdayName = (i) => ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"][i];
export const shortWeekday = (i) => ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][i];
export function durationText(min) {
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  return [hours ? `${hours} giờ` : "", rest ? `${rest} phút` : ""].filter(Boolean).join(" ");
}
export function countdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const STATUS = {
  AWAITING_PAYMENT: ["Chờ thanh toán", "warn"],
  CONFIRMED: ["Đã xác nhận", "ok"],
  IN_PROGRESS: ["Đang diễn ra", "ok"],
  COMPLETED: ["Đã hoàn thành", "done"],
  CANCELLED: ["Đã huỷ", "off"],
  EXPIRED: ["Hết hạn", "off"],
  NO_SHOW_PLAYER: ["Player vắng mặt", "off"],
  NO_SHOW_CUSTOMER: ["Khách vắng mặt", "off"],
  DISPUTED: ["Đang khiếu nại", "warn"],
};
export const statusPill = (status) => {
  const [label, tone] = STATUS[status] ?? [status, "off"];
  return h("span", { class: `pill pill-${tone}`, text: label });
};

// ---------------------------------------------------------------- art: initials avatars made of shapes, a star row

const PALETTE = [
  ["#FF5C9A", "#FFD23F", "#5CC8FF"],
  ["#5CC8FF", "#FF5C9A", "#FFD23F"],
  ["#FFD23F", "#7B61FF", "#FF5C9A"],
  ["#46D9A8", "#FFD23F", "#7B61FF"],
  ["#7B61FF", "#46D9A8", "#FFD23F"],
  ["#FF8A5C", "#5CC8FF", "#FFD23F"],
];
function hash(text) {
  let n = 2166136261;
  for (const ch of String(text)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619) >>> 0;
  return n;
}
const initials = (name) => [...String(name).trim().split(/\s+/).slice(-2).map((w) => [...w][0] ?? "")].join("").toUpperCase() || "?";

// A photo when the player has one, otherwise a small composition of shapes that is the same every time for the same person
export function avatar(player, { size = "md", photo = true } = {}) {
  const wrap = h("span", { class: `avatar avatar-${size}` });
  if (photo && player.photos?.[0]) {
    const img = h("img", { src: player.photos[0], alt: "", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => wrap.replaceChildren(art(player)));
    wrap.append(img);
  } else wrap.append(art(player));
  return wrap;
}
function art(player) {
  const n = hash(player.id ?? player.name);
  const [a, b, c] = PALETTE[n % PALETTE.length];
  const shapeB = [
    () => h("svg:circle", { cx: 74, cy: 28, r: 20, fill: b }),
    () => h("svg:rect", { x: 56, y: 8, width: 38, height: 38, rx: 10, fill: b, transform: `rotate(${(n >>> 3) % 40} 75 27)` }),
    () => h("svg:path", { d: "M74 6 L96 46 L52 46 Z", fill: b, "stroke-linejoin": "round" }),
  ][(n >>> 5) % 3]();
  const shapeC = (n >>> 7) % 2 ? h("svg:circle", { cx: 22, cy: 82, r: 14, fill: c }) : h("svg:rect", { x: 6, y: 66, width: 30, height: 30, rx: 8, fill: c });
  return h("svg:svg", { viewBox: "0 0 100 100", preserveAspectRatio: "xMidYMid slice", "aria-hidden": "true", focusable: "false" }, h("svg:rect", { width: 100, height: 100, fill: a }), shapeB, shapeC, h("svg:text", { x: 50, y: 62, "text-anchor": "middle", "font-size": 34, "font-weight": 800, fill: "#221E4A", "font-family": "Bricolage Grotesque, sans-serif" }, initials(player.name)));
}

export function stars(average, count) {
  const label = count ? `${average.toFixed(1)} sao, ${count} đánh giá` : "Chưa có đánh giá";
  return h("span", { class: "stars", role: "img", "aria-label": label }, h("span", { class: "star-glyph", "aria-hidden": "true", text: count ? "★" : "☆" }), h("span", { "aria-hidden": "true", text: count ? `${average.toFixed(1)} (${count})` : "Mới" }));
}

// ---------------------------------------------------------------- toast and dialogs

export function toast(message, tone = "info") {
  let region = $("#toasts");
  if (!region) {
    region = h("div", { id: "toasts", class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(region);
  }
  const node = h("div", { class: `toast toast-${tone}`, text: message });
  region.append(node);
  setTimeout(() => node.remove(), tone === "error" ? 7000 : 4000);
}

// A native dialog: focus is trapped and Escape closes it. Resolves true when confirmed.
export function confirmDialog({ title, body, ok = "Đồng ý", cancel = "Để sau", danger = false }) {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "dialog", "aria-labelledby": "dlg-title" }, h("h2", { id: "dlg-title", text: title }), typeof body === "string" ? h("p", { text: body }) : body, h("div", { class: "row end" }, h("button", { class: "btn btn-quiet", type: "button", text: cancel, onclick: () => dialog.close("no") }), h("button", { class: `btn ${danger ? "btn-danger" : "btn-main"}`, type: "button", text: ok, onclick: () => dialog.close("yes") })));
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "yes");
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// ---------------------------------------------------------------- the shell: header, bottom tabs, footer

function setTheme(next) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("theme", next);
  } catch {
    /* the choice just lasts until the page closes */
  }
}
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);

const here = () => location.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";

export async function shell() {
  const cfg = await loadConfig().catch(() => ({ loginEnabled: false, viewer: null, timezone: zone, games: [], discord: {} }));
  setZone(cfg.timezone);
  let me = null;
  if (cfg.viewer) me = await loadMe().catch(() => null);
  const next = encodeURIComponent(location.pathname + location.search);
  const items = [
    ["/", "Khám phá", "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"],
    ["/bookings", "Lịch của tôi", "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"],
    ...(me?.player ? [["/portal", "Cổng player", "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"]] : []),
  ];
  const link = ([href, label, icon], cls) => {
    const current = here() === href || (href !== "/" && here().startsWith(href));
    return h("a", { href, class: cls, "aria-current": current ? "page" : false }, h("svg:svg", { viewBox: "0 0 24 24", "aria-hidden": "true", class: "icon" }, h("svg:path", { d: icon })), h("span", { text: label }));
  };
  const toggle = h("button", { class: "icon-btn", type: "button", "aria-label": "Đổi giao diện sáng hoặc tối", "aria-pressed": String(isDark()), onclick: () => {
    setTheme(isDark() ? "light" : "dark");
    toggle.setAttribute("aria-pressed", String(isDark()));
  } }, h("svg:svg", { viewBox: "0 0 24 24", "aria-hidden": "true", class: "icon" }, h("svg:path", { d: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" })));

  const account = cfg.viewer
    ? h("div", { class: "account" }, h("span", { class: "who", text: cfg.viewer.name || "Bạn" }), h("button", { class: "btn btn-quiet btn-sm", type: "button", text: "Đăng xuất", onclick: async () => {
        await api("auth/logout", { method: "POST", body: {} }).catch(() => {});
        forgetMe();
        location.assign("/");
      } }))
    : cfg.loginEnabled
      ? h("a", { class: "btn btn-main btn-sm", href: `/api/auth/login?next=${next}`, text: "Đăng nhập Discord" })
      : null;

  clear($("#top"), h("div", { class: "bar wrap" }, h("a", { class: "brand", href: "/", "aria-label": `${SITE_NAME}, trang chủ` }, h("span", { class: "brand-mark", "aria-hidden": "true" }, h("svg:svg", { viewBox: "0 0 32 32" }, h("svg:rect", { width: 32, height: 32, rx: 9, fill: "#FFD23F" }), h("svg:circle", { cx: 12, cy: 14, r: 4, fill: "#221E4A" }), h("svg:circle", { cx: 21, cy: 14, r: 4, fill: "#FF5C9A" }), h("svg:path", { d: "M9 22q7 5 14 0", fill: "none", stroke: "#221E4A", "stroke-width": 2.4, "stroke-linecap": "round" }))), h("span", { class: "brand-name", text: SITE_NAME })), h("nav", { class: "nav-desk", "aria-label": "Chính" }, items.map((i) => link(i, "nav-link"))), h("div", { class: "bar-end" }, account, toggle)));
  const tabs = $("#tabs");
  if (tabs) clear(tabs, h("div", { class: "tabs-in" }, items.map((i) => link(i, "tab"))));
  clear($("#foot"), h("div", { class: "wrap foot-in" }, h("p", { text: "Dịch vụ dành cho người từ 18 tuổi, chỉ chơi game và trò chuyện lành mạnh." }), h("p", { class: "muted", text: "Phòng hẹn riêng nằm trên Discord, tiền thanh toán đi thẳng đến chủ server." })));
  return { cfg, me };
}

// ---------------------------------------------------------------- shared cards

export const loginCard = (cfg, text = "Đăng nhập bằng tài khoản Discord để tiếp tục.") =>
  h("section", { class: "notice" }, h("h2", { text: "Bạn chưa đăng nhập" }), h("p", { text }), cfg.loginEnabled ? h("a", { class: "btn btn-main", href: `/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`, text: "Đăng nhập bằng Discord" }) : h("p", { class: "muted", text: "Đăng nhập chưa được bật. Bạn quay lại sau nhé." }));

export const ageGateCard = (cfg) =>
  h("section", { class: "notice notice-gate", role: "alert" }, h("h2", { text: "Xác nhận bạn đủ 18 tuổi" }), h("p", { text: "Trước khi đặt lịch, bạn cần bấm xác nhận đủ 18 tuổi trong server Discord. Chỉ mất một lần, sau đó quay lại đây là đặt được ngay." }), cfg.discord?.ageGateUrl ? h("a", { class: "btn btn-main", href: cfg.discord.ageGateUrl, rel: "noopener", text: "Mở kênh xác nhận 18+" }) : cfg.discord?.inviteUrl ? h("a", { class: "btn btn-main", href: cfg.discord.inviteUrl, rel: "noopener", text: "Vào server Discord" }) : null);

export const joinCard = (cfg) =>
  h("section", { class: "notice notice-gate", role: "alert" }, h("h2", { text: "Vào server Discord trước nhé" }), h("p", { text: "Phòng hẹn nằm trong server Discord, nên bạn cần là thành viên để đặt lịch." }), cfg.discord?.inviteUrl ? h("a", { class: "btn btn-main", href: cfg.discord.inviteUrl, rel: "noopener", text: "Vào server Discord" }) : null);

export const skeleton = (n = 3) => h("div", { class: "skeletons", "aria-hidden": "true" }, Array.from({ length: n }, () => h("div", { class: "skeleton" })));

export const emptyState = (title, body, action) => h("div", { class: "empty" }, h("h3", { text: title }), h("p", { text: body }), action);

export function showError(root, error) {
  clear(root, h("div", { class: "notice", role: "alert" }, h("h2", { text: "Chưa tải được" }), h("p", { text: error.message }), h("button", { class: "btn btn-main", type: "button", text: "Thử lại", onclick: () => location.reload() })));
}
