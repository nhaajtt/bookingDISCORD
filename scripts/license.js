// Licenses for multi-server mode. Run it on the machine where the bot's data folder is (the bot may keep running).
//   npm run license -- issue --days 30 [--plan standard] [--guild <server id>] [--note "text"]
//   npm run license -- list
//   npm run license -- show <key or server id>
//   npm run license -- revoke <key>
// issue prints the key to give to the customer; they activate it in their server with /kichhoat. With --guild the key is tied to that
// server and starts at once.
import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { issueLicense, listLicenses, revokeLicense, getLicense, licenseStatus } from "../src/license.js";

const dayText = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "-");

export function run(argv, out = console.log) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith("--")) flags[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[(i += 1)] : true;
    else positional.push(rest[i]);
  }
  if (command === "issue") {
    const license = issueLicense({ days: Number(flags.days), plan: flags.plan ?? "standard", guildId: flags.guild ?? null, note: flags.note ?? "" });
    out(`Key: ${license.key}`);
    out(`Plan: ${license.plan}, ${license.days} days${license.guildId ? `, tied to server ${license.guildId}, ends ${dayText(license.expiresAt)}` : ", starts when it is activated with /kichhoat"}`);
    return license;
  }
  if (command === "list") {
    const all = listLicenses();
    if (!all.length) out("No licenses yet.");
    for (const l of all) out(`${l.key}  ${l.plan}  ${l.days}d  server ${l.guildId ?? "-"}  ends ${dayText(l.expiresAt)}${l.revokedAt ? "  REVOKED" : ""}${l.note ? `  ${l.note}` : ""}`);
    return all;
  }
  if (command === "show") {
    const target = positional[0];
    const byKey = getLicense(target);
    if (byKey) out(JSON.stringify(byKey, null, 2));
    else out(JSON.stringify(licenseStatus(target), null, 2));
    return byKey ?? null;
  }
  if (command === "revoke") {
    const ok = revokeLicense(positional[0]);
    out(ok ? "Revoked." : "No such key, or already revoked.");
    return ok;
  }
  out("Usage: license.js issue --days N [--plan P] [--guild ID] [--note T] | list | show <key|server> | revoke <key>");
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
