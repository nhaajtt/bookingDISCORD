import "dotenv/config";

const SNOWFLAKE = /^\d{17,20}$/;

function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Reads and checks the environment. Kept separate from the process-level check below so tests can call it with any object.
export function readConfig(env) {
  const multi = String(env.MULTI_TENANT ?? "").toLowerCase() === "true";
  const missing = ["DISCORD_TOKEN", "CLIENT_ID", ...(multi ? [] : ["GUILD_ID"])].filter((key) => !env[key]);
  const problems = [];
  if (env.PAYMENT_PROVIDER && !["payos", "stripe", "manual"].includes(env.PAYMENT_PROVIDER)) problems.push("PAYMENT_PROVIDER must be payos, stripe or manual");
  if (env.WEB_PORT && !(Number.isInteger(Number(env.WEB_PORT)) && Number(env.WEB_PORT) >= 0 && Number(env.WEB_PORT) < 65536)) problems.push("WEB_PORT must be a port number");
  if (env.WEB_SITE_URL && !/^https?:\/\/[^/\s]+$/.test(env.WEB_SITE_URL.replace(/\/+$/, ""))) problems.push("WEB_SITE_URL must be an origin such as https://book.example.com");
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) problems.push("SESSION_SECRET must be at least 32 characters");
  if (env.GUILD_ID && !SNOWFLAKE.test(env.GUILD_ID)) problems.push("GUILD_ID must be a Discord server ID");
  if (env.TIMEZONE && !validZone(env.TIMEZONE)) problems.push(`TIMEZONE is not a known time zone: ${env.TIMEZONE}`);
  return {
    missing,
    problems,
    config: {
      token: env.DISCORD_TOKEN,
      clientId: env.CLIENT_ID,
      // One bot instance runs exactly one booking server
      guildId: env.GUILD_ID ?? null,
      // Many servers in one process, each with its own database and its own license (see src/tenancy.js and src/license.js)
      multiTenant: multi,
      licenseRequired: multi ? String(env.LICENSE_REQUIRED ?? "true").toLowerCase() !== "false" : false,
      // Where the database, heartbeat and backups live (mount as a volume; ":memory:" is for tests)
      dataDir: env.DATA_DIR || "data",
      timezone: env.TIMEZONE && validZone(env.TIMEZONE) ? env.TIMEZONE : "Asia/Ho_Chi_Minh",
      // The owner's own payOS channel; all three are needed to take payments
      payos: {
        clientId: env.PAYOS_CLIENT_ID || null,
        apiKey: env.PAYOS_API_KEY || null,
        checksumKey: env.PAYOS_CHECKSUM_KEY || null,
      },
      stripe: { secretKey: env.STRIPE_SECRET_KEY || null, webhookSecret: env.STRIPE_WEBHOOK_SECRET || null },
      // Which gateway new payments use when both are configured
      paymentProvider: env.PAYMENT_PROVIDER || null,
      returnUrl: env.RETURN_URL || "https://discord.com/channels/@me",
      // The small web server: payOS webhook, the owner's dashboard and metrics. WEB_PORT 0 or empty keeps it off.
      web: {
        port: Number(env.WEB_PORT || 0),
        host: env.WEB_HOST || "0.0.0.0",
        dashboardToken: env.DASHBOARD_TOKEN || null,
        publicUrl: (env.WEB_PUBLIC_URL || "").replace(/\/+$/, "") || null,
        metricsToken: env.METRICS_TOKEN || null,
        // The public booking site: Discord login for it, the key that signs its sessions, and the origin the browser sees
        // (the site's own address, because /api is rewritten to the bot there). Without all three the /api routes answer 503.
        discordClientSecret: env.DISCORD_CLIENT_SECRET || null,
        sessionSecret: env.SESSION_SECRET || null,
        siteUrl: (env.WEB_SITE_URL || "").replace(/\/+$/, "") || null,
        discordInviteUrl: env.WEB_DISCORD_INVITE || null,
      },
      // Discord user IDs that always count as owner (comma separated)
      ownerIds: (env.OWNER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean),
      alertWebhookUrl: env.ALERT_WEBHOOK_URL || null,
    },
  };
}

const result = readConfig(process.env);
if (result.missing.length || result.problems.length) {
  if (result.missing.length) console.error(`Missing environment variables: ${result.missing.join(", ")}`);
  for (const problem of result.problems) console.error(problem);
  process.exit(1);
}

export const config = result.config;
