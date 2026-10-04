import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { withGuild, forEachGuild } from "../tenancy.js";
import { dashboardData } from "../domain/dashboard.js";
import { bookingsCsv, ledgerCsv } from "../domain/export.js";
import { walletLiability } from "../domain/wallet.js";
import { checkOrder } from "../jobs/payments.js";
import { verifyWebhookSignature } from "../pay/payos.js";
import { jobStates, renderMetrics, count } from "../metrics.js";
import { recordFailure, resetFailures, tokenValid, tooManyFailures, metricsAllowed } from "./auth.js";
import { renderDashboard } from "./page.js";
import { handleApi } from "./api.js";
import { log } from "../log.js";

// The small web server, off unless WEB_PORT is set:
//   POST /webhook/payos          payOS tells us a payment happened (the answer to "was it paid" still comes from payOS itself)
//   GET  /dashboard?token=       the owner's dashboard (also /api/stats, /ledger.csv, /bookings.csv)
//   GET  /metrics                Prometheus numbers (localhost, or METRICS_TOKEN)
//   /api/*                       the public booking site's JSON API (src/web/api.js, docs/web.md); /api/stats stays the owner's
//   GET  /healthz                200 when the bot's heartbeat is fresh
// In multi-server mode every path except /metrics and /healthz carries the server id: /dashboard/<guildId>, /webhook/payos/<guildId>.

const MAX_BODY = 64 * 1024;

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra });
  res.end(body);
  return true;
}
const json = (res, status, value) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function heartbeatAge() {
  try {
    const file = path.join(config.dataDir, "heartbeat");
    return existsSync(file) ? Date.now() - Number(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

// The business numbers for /metrics, read from the database of the server in front of us
function domainGauges(label = {}) {
  const db = getDb();
  const out = [];
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM bookings GROUP BY status").all()) out.push({ name: "booking_bot_bookings", help: "Bookings by status", labels: { ...label, status: r.status }, value: r.n });
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all()) out.push({ name: "booking_bot_orders", help: "Payment orders by status", labels: { ...label, status: r.status }, value: r.n });
  for (const r of db.prepare("SELECT kind, status, COALESCE(SUM(amount_vnd), 0) AS v FROM ledger GROUP BY kind, status").all()) out.push({ name: "booking_bot_ledger_vnd", help: "Ledger totals in dong", labels: { ...label, kind: r.kind, status: r.status }, value: r.v });
  out.push({ name: "booking_bot_wallet_liability_vnd", help: "Wallet credit customers still hold", labels: label, value: walletLiability().vnd });
  out.push({ name: "booking_bot_players", help: "Players by status", labels: { ...label, status: "active" }, value: db.prepare("SELECT COUNT(*) AS n FROM players WHERE status = 'ACTIVE'").get().n });
  return out;
}

export function createWebServer({ client = null, now = () => Date.now() } = {}) {
  async function handle(request, res) {
    const url = new URL(request.url, "http://local");
    const parts = url.pathname.split("/").filter(Boolean);
    const address = request.socket?.remoteAddress ?? "unknown";
    count("web_requests", { path: ["webhook", "dashboard", "api", "ledger.csv", "bookings.csv", "metrics", "healthz"].includes(parts[0]) ? parts[0] : parts.length ? "other" : "root" });

    if (parts.length === 0) return send(res, 200, "bookingDISCORD\n");

    if (parts[0] === "healthz") {
      const age = heartbeatAge();
      const ok = config.dataDir === ":memory:" || (age !== null && age < 90_000);
      return json(res, ok ? 200 : 503, { ok, heartbeatAgeMs: age });
    }

    if (parts[0] === "metrics") {
      if (!metricsAllowed(request)) return send(res, 401, "unauthorized\n");
      const gauges = [];
      await forEachGuild(async (guildId) => {
        gauges.push(...domainGauges(config.multiTenant ? { guild: guildId } : {}));
      });
      gauges.push({ name: "booking_bot_jobs_registered", help: "Background jobs that have run", value: Object.keys(jobStates()).length });
      return send(res, 200, renderMetrics(gauges, now()), "text/plain; version=0.0.4; charset=utf-8");
    }

    // /api/stats is the owner's token-protected JSON; every other /api path is the public site's API
    if (parts[0] === "api" && parts[1] !== "stats") {
      await handleApi({ request, res, url, parts, client, now });
      return undefined;
    }

    const routes = new Set(["webhook", "dashboard", "api", "ledger.csv", "bookings.csv"]);
    if (!routes.has(parts[0])) return send(res, 404, "not found\n");
    // Where the server id sits: after the first segment, or after the second for /webhook/payos and /api/stats
    const guildAt = parts[0] === "webhook" || parts[0] === "api" ? 2 : 1;
    const guildId = config.multiTenant ? parts[guildAt] : config.guildId;
    if (!guildId || (config.multiTenant && !/^\d{17,20}$/.test(guildId))) return send(res, 404, "not found\n");

    const handled = await withGuild(guildId, async () => {
      if (parts[0] === "webhook" && parts[1] === "payos") {
        if (request.method !== "POST") return send(res, 405, "method not allowed\n");
        let body;
        try {
          body = JSON.parse(await readBody(request));
        } catch (error) {
          return send(res, error.status ?? 400, "bad request\n");
        }
        if (!verifyWebhookSignature(body?.data, body?.signature)) {
          count("webhook_rejected");
          return send(res, 401, "bad signature\n");
        }
        count("webhook_accepted");
        json(res, 200, { success: true });
        const orderCode = Number(body.data?.orderCode);
        if (Number.isSafeInteger(orderCode)) {
          // Answer first, then look the order up with payOS: the webhook is only a nudge, never the proof of payment
          checkOrder(client, orderCode, now()).catch((error) => log.error("webhook.check_failed", { order: orderCode, error }));
        }
        return true;
      }

      if (parts[0] === "webhook") return send(res, 404, "not found\n");
      // Everything below is the owner's, behind the token
      if (request.method !== "GET") return send(res, 405, "method not allowed\n");
      if (tooManyFailures(address, now())) return send(res, 429, "slow down\n", "text/plain; charset=utf-8", { "retry-after": "60" });
      const given = url.searchParams.get("token") ?? String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!tokenValid(given)) {
        recordFailure(address, now());
        return send(res, 401, "unauthorized\n");
      }
      if (parts[0] === "dashboard") return send(res, 200, renderDashboard(dashboardData(now(), { days: Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 30)) })), "text/html; charset=utf-8");
      if (parts[0] === "api") return json(res, 200, dashboardData(now()));
      if (parts[0] === "ledger.csv") return send(res, 200, ledgerCsv(), "text/csv; charset=utf-8", { "content-disposition": 'attachment; filename="so-tien.csv"' });
      return send(res, 200, bookingsCsv(), "text/csv; charset=utf-8", { "content-disposition": 'attachment; filename="lich-dat.csv"' });
    });
    if (handled === undefined) return send(res, 404, "not found\n");
    return undefined;
  }

  const server = createServer((request, res) => {
    handle(request, res).catch((error) => {
      log.error("web.failed", { path: request.url?.split("?")[0], error });
      if (!res.headersSent) send(res, 500, "server error\n");
    });
  });
  server.requestTimeout = 15_000;
  return {
    server,
    listen: (port = config.web.port, host = config.web.host) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve(server.address().port));
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    resetFailures,
  };
}

export async function startWebServer(client) {
  if (!config.web.port) return null;
  const web = createWebServer({ client });
  const port = await web.listen();
  log.info("web.started", { port });
  return web;
}
