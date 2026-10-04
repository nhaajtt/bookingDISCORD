import { api, ApiFail } from "./api.js";
import { h, $, clear, shell, avatar, stars, fmtVnd, fmtK, fmtTime, shortWeekday, durationText, toast, skeleton, ageGateCard, joinCard, showError } from "./ui.js";

const id = new URLSearchParams(location.search).get("id");
const view = $("#view");

let cfg;
let viewer;
let player;
let days = [];
let startSet = new Set();
const pick = { game: null, durationMin: 60, startAt: null, day: 0, coupon: "" };
let quoteTimer = null;
let quoteSeq = 0;
const STEP = 30 * 60_000;

const fits = (start, min) => {
  for (let t = start; t < start + min * 60_000; t += STEP) if (!startSet.has(t)) return false;
  return true;
};
const validStarts = (day) => day.starts.filter((s) => fits(s, pick.durationMin));

// ---------------------------------------------------------------- profile column

function profile() {
  const photos = player.photos;
  const stage = h("div", { class: "stage" });
  const show = (i) => clear(stage, avatar({ ...player, photos: photos.length ? [photos[i]] : [] }, { size: "xl" }));
  show(0);
  const thumbs = photos.length > 1 ? h("div", { class: "thumbs", role: "group", "aria-label": "Ảnh của player" }, photos.map((p, i) => h("button", { class: "thumb", type: "button", "aria-label": `Xem ảnh ${i + 1}`, onclick: () => show(i) }, avatar({ ...player, photos: [p] }, { size: "sm" })))) : null;
  return h("section", { class: "profile", "aria-labelledby": "pname" },
    h("div", { class: "gallery" }, stage, thumbs),
    h("div", { class: "profile-info" },
      h("h1", { id: "pname", text: player.name }),
      h("div", { class: "row wrap-row" }, stars(player.rating.average, player.rating.count), h("span", { class: "muted", text: `${player.completed} buổi đã chơi` }), player.languages ? h("span", { class: "muted", text: player.languages }) : null),
      player.badges.length ? h("div", { class: "tags" }, player.badges.map((b) => h("span", { class: "tag tag-badge", text: b }))) : null,
      player.bio ? h("p", { class: "bio", text: player.bio }) : h("p", { class: "muted", text: "Player chưa viết giới thiệu." }),
      player.voiceUrl ? h("a", { class: "btn btn-quiet btn-sm", href: player.voiceUrl, target: "_blank", rel: "noopener noreferrer", text: "Nghe giọng mẫu" }) : null,
      h("h2", { class: "h3", text: "Giá theo game" }),
      h("ul", { class: "rates" }, player.games.map((g) => h("li", {}, h("span", { text: g.name }), h("strong", { text: `${fmtVnd(g.rateVnd)}/giờ` })))))
  );
}

// ---------------------------------------------------------------- booking panel

const panel = h("form", { class: "panel", "aria-labelledby": "book-title", novalidate: true });
const quoteBox = h("div", { class: "quote", "aria-live": "polite" });
const gateSlot = h("div", {});
const submit = h("button", { class: "btn btn-main btn-lg block-btn", type: "submit" });

function drawPanel() {
  const game = (g) => h("button", { class: "chip", type: "button", "aria-pressed": String(pick.game === g.name), onclick: () => {
    pick.game = g.name;
    changed();
  } }, g.name, h("span", { class: "chip-sub", text: fmtK(g.rateVnd) }));
  const durations = [];
  for (let m = 30; m <= cfg.maxDurationMin && durations.length < 8; m += 30) durations.push(m);
  const dur = (m) => h("button", { class: "chip", type: "button", "aria-pressed": String(pick.durationMin === m), text: durationText(m), onclick: () => {
    pick.durationMin = m;
    if (pick.startAt && !fits(pick.startAt, m)) pick.startAt = null;
    ensureDay();
    changed();
  } });

  const day = days[pick.day];
  const times = day ? validStarts(day) : [];
  clear(panel,
    h("h2", { id: "book-title", text: "Đặt lịch" }),
    h("fieldset", { class: "set" }, h("legend", { text: "Chơi gì?" }), h("div", { class: "chips" }, player.games.map(game))),
    h("fieldset", { class: "set" }, h("legend", { text: "Bao lâu?" }), h("div", { class: "chips" }, durations.map(dur))),
    h("fieldset", { class: "set" }, h("legend", { text: "Ngày nào?" }),
      h("div", { class: "days", role: "group", "aria-label": "Chọn ngày" }, days.map((d, i) => {
        const n = validStarts(d).length;
        const [y, m, dd] = d.date.split("-");
        return h("button", { class: "day", type: "button", disabled: n === 0, "aria-pressed": String(i === pick.day), "aria-label": `${shortWeekday(d.weekday)} ngày ${dd} tháng ${m}${n ? `, ${n} giờ trống` : ", hết giờ"}`, onclick: () => {
          pick.day = i;
          if (pick.startAt && !validStarts(days[i]).includes(pick.startAt)) pick.startAt = null;
          changed();
        } }, h("span", { class: "day-w", text: shortWeekday(d.weekday) }), h("span", { class: "day-n", text: `${dd}/${m}` }), h("span", { class: "day-c", text: n ? `${n}` : "–" }));
      }))),
    h("fieldset", { class: "set" }, h("legend", { text: "Giờ bắt đầu" }),
      times.length
        ? h("div", { class: "times" }, times.map((s) => h("button", { class: "time", type: "button", "aria-pressed": String(pick.startAt === s), text: fmtTime(s), onclick: () => {
            pick.startAt = s;
            changed();
          } })))
        : h("p", { class: "muted", text: days.some((d) => validStarts(d).length) ? "Ngày này hết giờ cho khoảng thời gian bạn chọn. Thử ngày khác hoặc chọn thời lượng ngắn hơn." : "Chưa có giờ trống trong 14 ngày tới." })),
    h("label", { class: "field" }, h("span", { class: "label", text: "Mã giảm giá (nếu có)" }),
      h("div", { class: "row" }, h("input", { id: "coupon", type: "text", maxlength: 20, autocomplete: "off", value: pick.coupon, disabled: !viewer, placeholder: viewer ? "" : "Đăng nhập để dùng mã", oninput: (e) => {
        pick.coupon = e.target.value.trim();
      }, onchange: () => changed() }))),
    quoteBox, gateSlot, submit);
  drawSubmit();
}

function drawSubmit() {
  const ready = pick.game && pick.startAt;
  submit.disabled = Boolean(viewer) && !ready;
  submit.textContent = !viewer ? "Đăng nhập để đặt lịch" : ready ? `Đặt lịch lúc ${fmtTime(pick.startAt)}` : "Chọn giờ để đặt";
}

function ensureDay() {
  if (days[pick.day] && validStarts(days[pick.day]).length) return;
  const first = days.findIndex((d) => validStarts(d).length);
  pick.day = first === -1 ? 0 : first;
}

function changed() {
  drawPanel();
  scheduleQuote();
}

function scheduleQuote() {
  clearTimeout(quoteTimer);
  if (!pick.game || !pick.startAt) return clear(quoteBox);
  quoteTimer = setTimeout(runQuote, 150);
}

async function runQuote() {
  const seq = (quoteSeq += 1);
  try {
    const body = { playerId: player.id, game: pick.game, startAt: pick.startAt, durationMin: pick.durationMin, ...(pick.coupon ? { coupon: pick.coupon } : {}) };
    const q = await api("quote", { method: "POST", body });
    if (seq !== quoteSeq) return;
    const line = (label, value, cls = "") => h("div", { class: `qline ${cls}` }, h("dt", { text: label }), h("dd", { text: value }));
    clear(quoteBox, h("dl", { class: "qlist" },
      line(`${q.game}, ${durationText(q.durationMin)}`, fmtVnd(q.listPriceVnd - q.surchargeVnd)),
      q.surchargeVnd > 0 ? line("Phụ thu giờ cao điểm", `+ ${fmtVnd(q.surchargeVnd)}`) : null,
      q.discountVnd > 0 ? line(`Mã ${q.couponCode}`, `− ${fmtVnd(q.discountVnd)}`, "qgood") : null,
      line("Tổng cộng", fmtVnd(q.priceVnd), "qtotal")), q.available ? null : h("p", { class: "warn-text", text: "Khung giờ này vừa có người đặt. Chọn giờ khác nhé." }));
    submit.disabled = !q.available && Boolean(viewer);
  } catch (error) {
    if (seq !== quoteSeq) return;
    clear(quoteBox, h("p", { class: "warn-text", role: "alert", text: error.message }));
  }
}

panel.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!viewer) return location.assign(`/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  if (!pick.game || !pick.startAt) return;
  submit.disabled = true;
  submit.textContent = "Đang giữ chỗ…";
  clear(gateSlot);
  try {
    const { booking } = await api("bookings", { method: "POST", body: { playerId: player.id, game: pick.game, startAt: pick.startAt, durationMin: pick.durationMin, ...(pick.coupon ? { coupon: pick.coupon } : {}) } });
    location.assign(`/booking?id=${booking.id}`);
  } catch (error) {
    if (error.code === "NOT_ATTESTED") clear(gateSlot, ageGateCard(cfg));
    else if (error.code === "NOT_IN_SERVER") clear(gateSlot, joinCard(cfg));
    else if (error.code === "LOGIN_REQUIRED") return location.assign(`/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    else toast(error.message, "error");
    if (["PLAYER_BUSY", "SLOT_HELD", "OUTSIDE_AVAILABILITY", "TOO_SOON"].includes(error.code)) {
      pick.startAt = null;
      await refreshDays();
    }
    drawPanel();
  }
});

async function refreshDays() {
  const data = await api(`players/${encodeURIComponent(id)}`);
  days = data.days;
  startSet = new Set(days.flatMap((d) => d.starts));
  ensureDay();
}

async function main() {
  clear(view, skeleton(2));
  ({ cfg } = await shell());
  viewer = cfg.viewer;
  if (!id) throw new ApiFail(404, { message: "Không thấy player này." });
  const data = await api(`players/${encodeURIComponent(id)}`);
  player = data.player;
  days = data.days;
  startSet = new Set(days.flatMap((d) => d.starts));
  document.title = `${player.name} | Chơi Cùng`;
  pick.game = player.games[0].name;
  ensureDay();
  clear(view, h("div", { class: "split" }, profile(), h("div", { class: "split-side" }, panel)));
  drawPanel();
}

main().catch((error) => {
  if (error.status === 404) clear(view, h("div", { class: "notice" }, h("h1", { class: "h2", text: "Không thấy player này" }), h("p", { text: "Player có thể đang nghỉ hoặc đã ngừng nhận lịch." }), h("a", { class: "btn btn-main", href: "/", text: "Về danh sách" })));
  else showError(view, error);
});
