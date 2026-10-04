import { getDb } from "./db.js";
import { CATALOG } from "./i18n/en.js";

// Languages. The bot is written in Vietnamese; English is added as a translation layer on the way out, so a handler never needs to know
// which language it is speaking. Everything a person is sent privately (replies, forms, buttons, private messages) is passed through
// translate() in that person's language. Text the whole server reads (cards, panels, log channels) stays Vietnamese.
//
// A person's language is the one they chose with /ngonngu, otherwise the one their Discord app reports (English apps get English),
// otherwise Vietnamese. Anything the catalog has no translation for is shown in Vietnamese rather than hidden.

export const LANGS = ["vi", "en"];

// ---------------------------------------------------------------- preferences

export function setLang(userId, lang, source = "manual", now = Date.now()) {
  if (!LANGS.includes(lang)) throw new Error("unknown language");
  getDb()
    .prepare("INSERT INTO user_prefs (user_id, lang, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET lang = excluded.lang, source = excluded.source, updated_at = excluded.updated_at WHERE user_prefs.source != 'manual' OR excluded.source = 'manual'")
    .run(userId, lang, source, now);
}

export const getPref = (userId) => getDb().prepare("SELECT lang, source FROM user_prefs WHERE user_id = ?").get(userId) ?? null;

// The language to speak to this person: their choice, else what their Discord app says (remembered, so private messages follow)
export function langFor(userId, locale = null) {
  if (!userId) return "vi";
  const pref = getPref(userId);
  if (pref) return pref.lang;
  if (locale) {
    const detected = String(locale).toLowerCase().startsWith("en") ? "en" : "vi";
    if (detected === "en") setLang(userId, "en", "auto");
    return detected;
  }
  return "vi";
}

// ---------------------------------------------------------------- the engine

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = new Map();
const patterns = [];

function add(vi, en) {
  if (!/\{\d+\}/.test(vi)) {
    exact.set(vi, en);
    return;
  }
  const parts = vi.split(/\{\d+\}/);
  const source = `^${parts.map(escapeRegex).join("([\\s\\S]+?)")}$`;
  patterns.push({ re: new RegExp(source), en, weight: parts.join("").length });
}
for (const [vi, en] of CATALOG) add(vi, en);
patterns.sort((a, b) => b.weight - a.weight);

const cache = new Map();

function lines(text) {
  return text.split("\n").map((line) => one(line)).join("\n");
}

// Translates one line: the whole line by exact match or pattern, otherwise sentence by sentence
function one(text) {
  if (!text.trim()) return text;
  const lead = /^\s*/.exec(text)[0];
  const tail = /\s*$/.exec(text)[0];
  const core = text.slice(lead.length, text.length - tail.length);
  return lead + core_(core) + tail;
}

function core_(core) {
  if (exact.has(core)) return exact.get(core);
  for (const p of patterns) {
    const m = p.re.exec(core);
    if (m) return p.en.replace(/\{(\d+)\}/g, (_, i) => core_(m[Number(i) + 1] ?? ""));
  }
  // The same text with its closing punctuation moved out ("Chờ thanh toán." is "Chờ thanh toán" and a full stop)
  const closing = /^([\s\S]*?[^.!?\s])([.!?]+)$/.exec(core);
  if (closing && closing[1].length < core.length) {
    const inner = core_(closing[1]);
    if (inner !== closing[1]) return inner + closing[2];
  }
  // Lists written as "a | b | c" are translated part by part
  if (core.includes(" | ")) return core.split(" | ").map((s) => core_(s)).join(" | ");
  const sentences = core.split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) return sentences.map((s) => core_(s)).join(" ");
  const clauses = core.split(/(?<=[;:])\s+/);
  if (clauses.length > 1) return clauses.map((s) => core_(s)).join(" ");
  return core;
}

const DAYS_EN = { T2: "Mon", T3: "Tue", T4: "Wed", T5: "Thu", T6: "Fri", T7: "Sat", CN: "Sun" };

// Wall-clock days, money and durations are written by shared helpers in Vietnamese form; they are rewritten here
function after(text) {
  return text
    .replace(/(^|[^A-Za-z0-9#])(CN|T[2-7])(?=\s\d)/g, (_, pre, day) => `${pre}${DAYS_EN[day]}`)
    .replace(/(\d{1,3}(?:\.\d{3})+|\d+)\s?đ(?![\p{L}])/gu, (_, n) => `${n.replace(/\./g, ",")} VND`)
    .replace(/(\d+(?:,\d+)?) giờ(?![\p{L}])/gu, (_, n) => `${n.replace(",", ".")} h`)
    .replace(/(\d+) phút(?![\p{L}])/gu, "$1 min")
    .replace(/\/giờ(?![\p{L}])/gu, "/hour");
}

export function translate(text, lang) {
  if (lang !== "en" || typeof text !== "string" || !text) return text;
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const result = after(lines(text));
  if (cache.size > 5000) cache.clear();
  cache.set(text, result);
  return result;
}

// ---------------------------------------------------------------- whole messages

const dataOf = (x) => x?.data ?? x;

// English is often longer than Vietnamese, and Discord refuses text over its limits, so every translated piece is cut to the limit of the
// place it goes in
const clip = (text, max) => (typeof text === "string" && text.length > max ? `${text.slice(0, max - 1)}…` : text);
const tr = (text, lang, max) => clip(translate(text, lang), max);

function embed(e, lang) {
  const d = dataOf(e);
  if (!d || typeof d !== "object") return;
  if (typeof d.title === "string") d.title = tr(d.title, lang, 256);
  if (typeof d.description === "string") d.description = tr(d.description, lang, 4096);
  if (d.footer?.text) d.footer.text = tr(d.footer.text, lang, 2048);
  if (d.author?.name) d.author.name = tr(d.author.name, lang, 256);
  for (const f of d.fields ?? []) {
    f.name = tr(f.name, lang, 256);
    f.value = tr(f.value, lang, 1024);
  }
}

// limits: the label of a button is 80, of a form field 45; a menu's placeholder 150; a menu option's label and description 100
function component(c, lang, { label = 80, placeholder = 150 } = {}) {
  const d = dataOf(c);
  if (!d) return;
  if (typeof d.label === "string") d.label = tr(d.label, lang, label);
  if (typeof d.placeholder === "string") d.placeholder = tr(d.placeholder, lang, placeholder);
  for (const o of c.options ?? d.options ?? []) {
    const od = dataOf(o);
    if (od) {
      if (typeof od.label === "string") od.label = tr(od.label, lang, 100);
      if (typeof od.description === "string") od.description = tr(od.description, lang, 100);
    }
  }
}

// translatePayload(payload, lang) -> the same payload with its text in `lang`. Builders are changed in place (they are made fresh for every
// answer); plain strings are returned translated.
export function translatePayload(payload, lang) {
  if (lang !== "en" || !payload) return payload;
  if (typeof payload === "string") return translate(payload, lang);
  if (typeof payload !== "object") return payload;
  if (typeof payload.content === "string") payload.content = tr(payload.content, lang, 2000);
  for (const e of payload.embeds ?? []) embed(e, lang);
  for (const row of payload.components ?? []) for (const c of row?.components ?? row?.data?.components ?? []) component(c, lang);
  return payload;
}

// A form: its title, the labels and hints of its fields
export function translateModal(modal, lang) {
  if (lang !== "en") return modal;
  const d = dataOf(modal);
  if (d?.title) d.title = tr(d.title, lang, 45);
  for (const row of modal.components ?? d?.components ?? []) {
    for (const c of row?.components ?? row?.data?.components ?? []) component(c, lang, { label: 45, placeholder: 100 });
  }
  return modal;
}

// Makes the answers of an interaction come out in the person's language
export function localizeAnswers(interaction, lang) {
  if (lang !== "en") return;
  for (const name of ["reply", "editReply", "followUp", "update"]) {
    const original = interaction[name]?.bind(interaction);
    if (original) interaction[name] = (payload, ...rest) => original(translatePayload(payload, lang), ...rest);
  }
  const showModal = interaction.showModal?.bind(interaction);
  if (showModal) interaction.showModal = (modal) => showModal(translateModal(modal, lang));
}
