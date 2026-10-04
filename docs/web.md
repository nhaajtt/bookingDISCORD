# The public booking site

A static site (`site/`) lets people browse players, pick a slot, pay and manage their bookings in a browser. The bot stays the only place that holds data and rules: the site is a front for a JSON API (`src/web/api.js`) that calls the same domain functions the Discord flow uses, so overlap, lead time, strikes, blacklist, the 18+ confirmation, the active-booking cap, refunds and the ledger behave identically.

## Architecture

```
browser ──https──> Vercel (static site, site/)
                     │  /api/*  rewritten to
                     ▼
              https://<pi>.<tailnet>.ts.net/api/*   (Tailscale Funnel)
                     │
                     ▼
              bot web server on the Raspberry Pi (WEB_PORT)
```

- The browser only ever talks to the site's own origin. Vercel rewrites `/api/*` to the bot, so the login cookie is first-party and there is no CORS. Wide-open CORS is never enabled.
- Login is Discord OAuth2 (authorization code, scope `identify`). The bot keeps only the Discord id and display name in an HMAC-signed, HttpOnly, `SameSite=Lax` cookie that lasts 7 days.
- Every request that is not a GET must carry an `Origin` (or `Referer`) equal to `WEB_SITE_URL`; anything else is refused.
- Payment links (payOS/Stripe) reuse `src/pay/checkout.js`. If no gateway is configured the API answers `payment_unavailable`; paying from the wallet works regardless.
- Private rooms and notifications are not duplicated: a web booking paid from the wallet calls `client.notifyBooking` exactly like the Discord button, and the `schedule` job opens the rooms 10 minutes before the start for any CONFIRMED booking.
- Single-server mode only. With `MULTI_TENANT=true` the `/api` routes answer 503.
- Customers must be members of the Discord server (rooms are made for their account). A visitor who is not gets `NOT_IN_SERVER` and the invite link.

## Environment variables (bot)

| Variable | Meaning |
| --- | --- |
| `WEB_PORT` | Turns the web server on (it is off when empty or `0`). Use a local port, for example `8080` |
| `WEB_HOST` | Address to listen on. Use `127.0.0.1` when only Tailscale Funnel talks to it |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret of the Discord application |
| `SESSION_SECRET` | 32+ random characters that sign the cookies, for example `openssl rand -base64 48` |
| `WEB_SITE_URL` | The origin the browser sees, for example `https://book.example.com`. Used for redirects, the OAuth redirect URI and the Origin check |
| `WEB_DISCORD_INVITE` | Optional invite link shown to visitors who are not on the server yet |
| `RETURN_URL` | Optional: where payment gateways send people afterwards. Set it to `https://<site>/bookings` |

Until `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` and `WEB_SITE_URL` are all set, login and the logged-in routes answer 503 with a clear message. The public reads (`/api/config`, `/api/players`) keep working. The existing `/webhook/payos`, `/dashboard`, `/api/stats` and `/metrics` are unchanged.

Changing `SESSION_SECRET` logs everybody out.

## Discord OAuth2

1. Discord Developer Portal, your application, OAuth2.
2. Copy the client secret into `DISCORD_CLIENT_SECRET`.
3. Under Redirects add exactly `<WEB_SITE_URL>/api/auth/callback`, for example `https://book.example.com/api/auth/callback`.
4. No other scope than `identify` is requested.

## Tailscale Funnel on the Raspberry Pi

```sh
# once: install and log in (https://tailscale.com/download/linux)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# enable HTTPS and Funnel for the tailnet in the admin console (DNS: HTTPS certificates; Access controls: funnel attribute)

# send the public https address to the bot's web port, in the background
sudo tailscale funnel --bg 8080
tailscale funnel status          # shows https://<pi>.<tailnet>.ts.net
```

Set `WEB_PORT=8080` and `WEB_HOST=127.0.0.1` in the bot's `.env` and restart it. Open `https://<pi>.<tailnet>.ts.net/healthz` to check it answers. `sudo tailscale funnel --https=443 off` stops the exposure.

Everything on that address is public, so only `/api/*` should be used from the site. `/dashboard` still needs its token and `/metrics` refuses forwarded requests unless `METRICS_TOKEN` is set. If you want to expose less, put a path in the command (`tailscale funnel --bg --set-path /api 8080`).

## Vercel deploy

1. Edit `site/vercel.json` and replace `BOT-HOST.example.ts.net` with your Funnel host name.
2. Import the repository in Vercel, set **Root Directory** to `site`, Framework Preset **Other**, no build command, no output directory.
3. Add your domain in Vercel and put the same address in the bot's `WEB_SITE_URL` (without a trailing slash).
4. Add the redirect URI in the Discord portal (above) and restart the bot.
5. Open the site, log in with Discord, confirm 18+ in the server if asked, and book a small test slot.

Or from a terminal: `cd site && npx vercel --prod`.

`site/vercel.json` also sets the security headers: scripts only from the site itself, styles and fonts only from Google Fonts, no framing, no sniffing, a strict referrer policy, and `no-store` on `/api`.

The site name shown in the header lives in `site/js/ui.js` (`SITE_NAME`) and the page titles in the HTML files.

## API

Errors are always `{ "error": { "code", "message" } }` with a Vietnamese message. Bodies are JSON, at most 16 KB.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/config` | anyone | public settings (lead time, horizon, durations, payment by link on or off), the games on offer, the Discord links, and who is logged in |
| `GET /api/players?game=&q=&free=1&sort=` | anyone | active players: name, games with rate per game, bio, languages, rating, completed count, badges, photos, free now, next free time |
| `GET /api/players/:id` | anyone | the same plus free 30-minute starts for the next 14 days (weekly hours minus bookings, lead time and horizon applied) |
| `POST /api/quote` | anyone (a coupon needs login) | `{ playerId, game, startAt, durationMin, coupon? }` -> price, surcharge, discount, fee, availability |
| `GET /api/auth/login`, `GET /api/auth/callback`, `POST /api/auth/logout` | | Discord login |
| `GET /api/me` | logged in | profile, 18+ confirmed, wallet, my bookings (with cancel preview), my waiting list, player status |
| `POST /api/bookings` | logged in | `{ playerId, game, startAt, durationMin, coupon?, payWith?: "wallet" or "link" }` creates the booking awaiting payment and optionally pays it |
| `POST /api/bookings/:id/pay-wallet`, `/pay-link`, `/cancel`, `/rate` | the customer | pay from the wallet, get a payment link, cancel with the normal refund rules, rate (`{ stars, review? }`) |
| `GET /api/me/player`, `GET/PUT /api/me/availability`, `POST /api/me/status` | active or paused players | the portal: weekly hours as text, upcoming bookings, what is owed, pause and resume |

Never returned: emails, bank details, internal notes, other people's bookings, customer ids to players beyond the last four digits.

Rate limits (in memory): 240 requests a minute per address, 90 a minute per person, and the same buckets as Discord for booking, wallet, rating, coupons and hours.

## Local preview

Run the bot with `WEB_PORT`, `WEB_SITE_URL=http://localhost:3000` and the secrets set, serve `site/` on port 3000 with any static server that forwards `/api` to the bot, and add `http://localhost:3000/api/auth/callback` as a redirect in the Discord portal.
