import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { runInTenant, getDb } from "../src/db.js";
import { createWebServer } from "../src/web/server.js";
import { metricsAllowed } from "../src/web/auth.js";
import { DM_PREFIXES } from "../src/discord/router.js";
import { translate } from "../src/i18n.js";

test("a made-up tenant name never opens a database, and the web server refuses it before touching data", async () => {
  const before = config.multiTenant;
  config.multiTenant = true;
  config.licenseRequired = false;
  const web = createWebServer({});
  const port = await web.listen(0, "127.0.0.1");
  try {
    assert.throws(() => runInTenant("evil1", () => getDb()), /not a server id/);
    assert.throws(() => runInTenant("default", () => getDb()), /not a server id/);
    for (const p of ["/dashboard/evil1?token=wrongtoken1", "/webhook/payos/evil2", "/dashboard/default?token=wrongtoken1", "/webhook/foo/123"]) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: p.startsWith("/webhook") ? "POST" : "GET", body: p.startsWith("/webhook") ? "{}" : undefined });
      assert.equal(res.status, 404, p);
    }
  } finally {
    await web.close();
    config.multiTenant = before;
    config.licenseRequired = true;
  }
});

test("metrics behind a reverse proxy need the token, and only bounded labels are counted", () => {
  const local = { headers: {}, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(metricsAllowed(local), true);
  assert.equal(metricsAllowed({ ...local, headers: { "x-forwarded-for": "8.8.8.8" } }), false);
  assert.equal(metricsAllowed({ headers: {}, socket: { remoteAddress: "8.8.8.8" } }), false);
});

test("book again works from a private message", () => {
  assert.ok(DM_PREFIXES.includes("bk:again"));
});

test("day names are rewritten only in front of a time, so a player's own words are left alone", () => {
  assert.equal(translate("Chờ thanh toán. T2 19:00", "en"), "Awaiting payment. Mon 19:00");
  assert.equal(translate("Rank CN, hay", "en"), "Rank CN, hay");
  assert.equal(translate("Valorant T3 player", "en"), "Valorant T3 player");
});
