import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const read = (...p) => readFileSync(path.join(root, ...p), "utf8");

test("the site never builds HTML from data and never loads a script from outside", () => {
  for (const file of readdirSync(path.join(root, "js"))) {
    const code = read("js", file);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(code), `${file} writes raw HTML or evals`);
  }
  for (const file of readdirSync(root).filter((f) => f.endsWith(".html"))) {
    const html = read(file);
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), `${file} has an inline script`);
    assert.ok(!/\sstyle=|\son[a-z]+=/.test(html), `${file} has inline styles or handlers`);
    for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) assert.ok(m[1].startsWith("/"), `${file} loads ${m[1]}`);
    assert.match(html, /<html lang="vi">/);
  }
});

test("vercel.json rewrites /api to the bot and sends the security headers", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.deepEqual(config.rewrites[0], { source: "/api/(.*)", destination: "https://BOT-HOST.example.ts.net/api/$1" });
  const all = config.headers.find((h) => h.source === "/(.*)").headers;
  const csp = all.find((h) => h.key === "Content-Security-Policy").value;
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.ok(all.some((h) => h.key === "X-Content-Type-Options"));
  assert.ok(config.headers.some((h) => h.source === "/api/(.*)" && h.headers[0].value === "no-store"));
});
