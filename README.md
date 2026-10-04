# bookingDISCORD

A Discord bot that runs a "book a friend" server almost by itself. Customers book a player's time to play a game together or just to talk, pay through payOS or Stripe (or from a prepaid wallet), and the bot handles availability, reminders, private rooms, start and end detection, extensions, ratings, cancellations, no-shows, disputes and the money bookkeeping. The owner only handles exceptions.

**Status: 1.0.0 release candidate.** Every feature below is built and covered by tests that run against fakes of Discord, payOS and Stripe. What has not been done by anyone yet is a run against a real Discord server and real payment keys: do that with `npm run smoke` and a small test booking before you open the server to people (see "First run"). The rules live in `src/domain`, `src/pay` and `src/settings.js` without any Discord import; `src/commands`, `src/flows`, `src/discord`, `src/events` and the jobs translate between Discord and those rules and implement none of them. The specification is [docs/design.md](docs/design.md).

## How it works

- One bot instance per booking server by default. The owner's own payment keys and one `GUILD_ID` live in the environment. Many servers in one bot, each with its own data, keys and license, is an option (see "Many servers").
- The bot never holds money. Payments go to the owner's own payOS or Stripe account. The bot keeps an honest **ledger** of what the owner owes players (payouts) and customers (refunds). Refunds of Stripe payments go back to the card automatically; everything else the owner sends by hand and marks paid with `/chuyentien`, which can show a VietQR code with the amount and note already in it and export CSV. Currency is VND, whole dong only: every payment splits exactly into fee, refund and player share.
- A prepaid **wallet** lets customers top up with a package (with a bonus), pay bookings from it and get refunds straight back into it. The credit is service the owner owes, shown in the owner's numbers.
- Adults only and safe for work: everyone confirms once that they are 18 or older (stored with a time). Content is gaming and conversation only.
- No privileged intents (Guilds, GuildVoiceStates, GuildMessages). Message content and the member list are never read; members are fetched one at a time by id.
- Vietnamese by default, English for people who choose it or whose Discord app is English (see "Languages").

## Setup

Requires Node 22.13 or newer.

```sh
npm install
cp .env.example .env     # fill in the values, never commit this file
npm test
npm run deploy-commands  # registers the slash commands
npm run smoke            # checks the token, the server, the bot's permissions and the payment keys
npm start
```

With Docker (a health check reads `data/heartbeat`):

```sh
docker compose up -d --build
docker compose exec bot node scripts/smoke.js
```

On a Raspberry Pi, `scripts/install-pi.sh` installs Docker, fetches the project, asks for the token, application ID and server ID, and can install a daily self-update timer (`scripts/update.sh` rolls back on a failed health check).

### First run on the server

1. Invite the bot with the `bot` and `applications.commands` scopes and only these permissions: View Channels, Send Messages, Embed Links, Read Message History, Manage Channels, Manage Roles, Attach Files, Connect, Speak, Stream, Mention Everyone, Create Invite, Add Reactions, Create Public and Private Threads, Send Messages in Threads (Discord only lets a bot allow or deny permissions it holds itself; the rooms and channels use these. The bot never mentions everyone: every message it sends has mention parsing off). Do not give it Administrator. No privileged intent needs to be switched on in the developer portal.
2. Run `/setup` as an administrator (or a user listed in `OWNER_IDS`). It creates the roles Khách, Người chơi, Trusted, Khách quen and Staff, the categories and channels listed below, posts the rules, the 18+ button, the guide, the apply and booking panels, and stores every id in the settings. Run it again whenever you like: it finds what exists by id, then by name, creates only what is missing, rewrites the permission overwrites and edits the panels in place. It never deletes anything.
3. Read the "Cần sửa" part of the answer. The usual fix is to drag the bot's role above Khách, Người chơi, Trusted and Khách quen and below Staff in Server Settings, Roles. `npm run smoke` checks this too.
4. Give the Staff role to your moderators. The staff and money commands are hidden from everyone but administrators by default; in Server Settings, Integrations, open the bot and allow `/staff` for the Staff role. `/chuyentien`, `/admin`, `/magiamgia` and `/setup` stay owner only (administrators or `OWNER_IDS`).
5. Players apply in the apply channel, staff approve in the staff queue, and players enter their hours with `/lichranh`.
6. Make one real booking with a player you trust and a small amount, pay it, let it run, rate it, and look at `/chuyentien` afterwards.

## What `/setup` builds

| Category | Channels | Who sees it |
| --- | --- | --- |
| BẮT ĐẦU | `luật-lệ`, `xác-nhận-18` | everyone, read only |
| | `hướng-dẫn` | Khách |
| ĐẶT LỊCH | `đặt-lịch`, `danh-sách-player`, `đánh-giá` | Khách, read only (the bot posts) |
| | `hỗ-trợ` | Khách and Staff |
| PLAYER | `đăng-ký-player` | Khách, read only |
| | `góc-player` | Người chơi and Staff |
| NHÂN VIÊN | `duyệt-player`, `nhật-ký` | Staff, read only |
| | `khiếu-nại` | Staff |
| | `sổ-tiền` | owners only (not even Staff) |
| PHÒNG HẸN | `lich-<id>-text`, `lich-<id>-voice` | the two people of a booking and the bot; Staff read the text room |

A member who has not confirmed 18+ sees only `luật-lệ` and `xác-nhận-18`.

## Commands

| Command | Who | What |
| --- | --- | --- |
| `/datlich [player] [game]` | confirmed adults | opens the booking form (game, date and time, duration, discount code, weekly repeat), or a menu of players |
| `/timplayer` | confirmed adults | find players by game, price, rating, language, who is free now, sorted as you like, with a button to book each |
| `/lichcuatoi` | confirmed adults | your bookings, with cancel and book-again buttons |
| `/hangcho` | confirmed adults | slots you wait for and weekly repeats, with buttons to leave or stop |
| `/vi xem`, `nap`, `doi-diem` | confirmed adults | wallet balance and history, top up with a package, turn loyalty points into credit |
| `/thanhvien` | confirmed adults | buy a membership plan from the wallet for a percent off every booking while it runs |
| `/goiy` | confirmed adults | up to five players picked from the games you booked before, how you rated them, their stars and who is free, each with its reason |
| `/quatang mua`, `nhap`, `cua-toi` | confirmed adults | buy a gift card from your wallet, give the code to a friend, they enter it and the amount lands in their wallet |
| `/gioithieu ma`, `nhap` | confirmed adults | your referral code, and enter a friend's code before your first booking; both get wallet credit after the newcomer's first session |
| `/nganhang cap-nhat`, `xem`, `xoa` | confirmed adults | where the owner sends your money (payouts, refunds); the owner sees it with a VietQR code |
| `/baocao [nguoi]` | confirmed adults | an anonymous report to staff: they see the text and who it is about, never who wrote it |
| `/bangxephang [thang]` | confirmed adults | leaderboard of players (hours) and customers (spending), this month or last |
| `/ngonngu` | everyone | Vietnamese or English for your private messages |
| `/player dang-ky`, `thong-tin`, `gia-theo-game`, `anh-gioi-thieu`, `tam-nghi`, `nhan-lai` | confirmed adults, players | apply, edit the profile, a price per game, photos and a voice sample (links), pause, resume |
| `/lichranh [lich] [chon]` | players | weekly hours as text (`T2 19:00-23:00; CN 09:00-12:00`, mistakes are explained) or with menus (`chon:true`) |
| `/thunhap` | players | earnings, what is waiting to be transferred, next bookings |
| `/staff duyet`, `khieu-nai`, `huy-lich`, `phat`, `mo-khoa`, `cam`, `bo-cam`, `tong-ket`, `xem-khach`, `ghi-chu`, `xoa-ghi-chu` | staff | applications, disputes, cancel a booking, strikes, suspensions, blacklist, summary, a customer's history with internal notes |
| `/chuyentien [che-do]` | owners | the money queue with bank details; `qr` shows a VietQR per row; `csv`, `csv-tat-ca`, `csv-lich` export for the accountant |
| `/magiamgia tao`, `danh-sach`, `tat`, `bat` | owners | discount codes (paid out of the platform fee, never out of the player's share) |
| `/admin cai-dat`, `sao-luu`, `donhang`, `nhat-ky`, `dieu-chinh-vi`, `bang-dieu-khien`, `giay-phep`, `thanh-toan` | owners | settings, backup, recent orders, the audit trail, wallet corrections, the web dashboard link, license status, payment keys (many-server mode) |
| `/setup` | owners | build or repair the server layout |
| `/kichhoat` | server administrators | activate a license key (many-server mode only) |

Settings groups in `/admin cai-dat`: fees and limits, times, cancellation policy and notes, peak-hour prices, quiet-hour discounts, membership plans, referral rewards, wallet top-up packages, and extras (extension length, waiting-list hold, weekly repeat length, loyalty points).

Buttons: the 18+ gate, apply, approve and reject, book (on every card and search result), cancel, rate (1 to 5 stars, also in DMs), book again, report a problem, extend a session, pay from the wallet or by link, join the waiting list, confirm or skip a weekly repeat, resolve a dispute, mark a transfer paid. Every handler checks who is clicking, so a forged button does nothing.

## Booking rules in short

- **Price.** The player's hourly rate for the game (a per-game price if they set one), counted per half hour, plus the **peak-hour surcharge** of the half hours inside a peak window. The fee is a percent of that, rounded to a thousand dong.
- **Quiet-hour discounts and memberships.** A percent off (at most 50 for quiet hours, 30 for a plan) taken out of the fee like a coupon, so the player is paid what they would have been. Quiet hours are windows like the peak ones; a membership is bought from the wallet for a number of days, and renewing early adds days. All discounts together can take at most the fee.
- **Tips.** After a session the customer can tip the player from the wallet (5.000 to 2.000.000 đ, once per session, within a week). The player gets all of it; it shows in the owner's payout queue as a tip row with no waiting period.
- **Referral.** Everyone has a code (`/gioithieu ma`). A newcomer enters it before their first booking; when their first session worth at least the set amount finishes, both get wallet credit paid by the owner.
- **Trust and safety.** Staff can give a player a **Verified** badge after checking them (`/staff xac-minh`; the bot stores only who vouched and when, never documents). Every room has an **Emergency** button: it tells staff and the owners at once, lets staff into the voice room and, once the session has started, freezes the money like a complaint. After a session the player rates the customer in a private message; only staff see it. `/staff xem-khach` shows a **risk level** built from strikes, rejected complaints, reports, alerts, no-shows and those ratings, with every reason listed; it never blocks anyone by itself.
- **Discount codes** take at most the fee of the booking, so the player is paid exactly what they would have been. A code is held by an unpaid booking and given back if it expires or is cancelled.
- **Waiting list.** A taken slot offers "tell me when it opens". When it frees up the first in line is told and the slot is held for them for a while (default 30 minutes), then the next one.
- **Weekly repeat.** Fill in a number of weeks when booking. The first week is booked; three days before each next week the customer gets a message with one button. Nothing is charged and no slot is held until they press it.
- **Extensions.** From the room, the customer adds 30 minutes at a time while the session runs, as far as the player is free. It is paid the same way as the booking (wallet or link), the minutes are held while the link is open, and the same booking simply gets longer, so ledger, payout and refunds follow.
- **Cancellation tiers**, strikes, no-shows and disputes as in the design document. A player who leaves the server is paused and their upcoming bookings are refunded.
- **Wallet.** Top up a package (for example pay 1.000.000, get 1.100.000). A booking paid from the wallet is refunded to the wallet; a booking paid by link is refunded to the owner's queue (or to the card, for Stripe). Points are earned on completed sessions and can be turned into wallet credit.
- **Badges and leaderboards.** Top of the month, 50 and 100 hours, punctual, many returning customers, shown on the profile card; the winners of a month are written once so a badge does not change afterwards.

## Automation

| Job | Every | What |
| --- | --- | --- |
| `payments` | 30 s | polls the gateways for open orders, confirms bookings, top-ups and extensions, announces late, duplicate and partial payments |
| `schedule` | 30 s, and at once when someone joins a booking's voice room | reminders (24 h, 1 h, 10 min), opens private rooms 10 minutes before, starts a session when both are in the voice room, handles no-shows after one extra tick, ends sessions, asks for ratings, closes rooms, expires unpaid bookings |
| `waitlist` | 1 min | tells the first person in line when a slot is free, holds it, moves on to the next |
| `series` | 30 min | asks about the next week of a weekly repeat three days before it |
| `refunds` | 5 min | sends Stripe refunds back to the card (idempotent) and marks the ledger row |
| `roles` | 1 day | Trusted and Khách quen roles from the facts; finds players who left the server (members fetched one by one) |
| `cards` | 1 day | refreshes every profile card (ratings, badges, prices) and the guide's cancellation table |
| `leaderboard` | 6 h | once a month posts the winners of the month that ended and refreshes the cards |
| `digest` | 1 hour | from 08:00 local, once per date, a morning summary (Monday: the week) in `sổ-tiền`, with a license warning in many-server mode |
| `backup` | 1 day | database copy, seven kept |

## Payments

- **payOS** (`PAYOS_*`): a link per order, polled every 30 seconds. With the web server on, the payOS webhook (`POST /webhook/payos`) makes the bot look the order up at once; the webhook is checked with the channel's checksum key and is only a nudge, the answer to "was it paid" always comes from payOS.
- **Stripe** (`STRIPE_SECRET_KEY`): Checkout sessions in VND. Refunds are sent back automatically with an idempotency key per ledger row and order, so a retry can never refund twice. Money that arrives late is refunded the same way.
- **Bank transfer** (`manual`, needs no keys): the owner saves their receiving account with `/admin nhan-tien`; customers then get a VietQR image with the amount and a short note, transfer, and the owner presses **Đã nhận tiền** in the money log (or in `/admin cho-xac-nhan`) when the money shows in their banking app. Only then does the booking, wallet top-up or extension go through. A confirmation after the booking expired is refunded as a late payment. It is used when no gateway has keys; a gateway with keys takes over by default (`PAYMENT_PROVIDER=manual` forces transfers).
- `PAYMENT_PROVIDER` picks the gateway for new payments when more than one is on. Adding another gateway means one entry in `src/pay/gateway.js` (create link, read payment, optionally close and refund).
- Money that cannot be handled automatically (a second payment for a booking already paid, a paid extension the session can no longer take, a link that closed half paid) is reported in the money log and to the alert webhook for a manual refund, never silently kept.

## Web server (optional)

Set `WEB_PORT` to turn it on. Put a reverse proxy with https in front of it before exposing it.

| Path | What |
| --- | --- |
| `GET /dashboard?token=...` | the owner's dashboard: revenue, completed sessions, cancellation and dispute rate, returning customers, ratings, money to hand over, wallet credit, top players and customers, order states, charts for the last 7 to 90 days |
| `GET /api/stats`, `/ledger.csv`, `/bookings.csv` | the same numbers as JSON and CSV |
| `POST /webhook/payos` | the payOS webhook |
| `GET /metrics` | Prometheus text: bookings and orders by status, ledger totals, wallet credit, job runs and failures. Localhost only, or `Authorization: Bearer METRICS_TOKEN` |
| `GET /healthz` | 200 while the heartbeat is fresh |

`/admin bang-dieu-khien` shows the dashboard address with a token only the owner sees (`tao-lai-ma:true` replaces it). Wrong tokens are rate limited per address.

## Public booking site

The `site/` folder is a static site (deployable to Vercel as it is) where people browse players, pick a slot, pay and manage bookings, and players edit their hours. It talks to a JSON API in the web server (`src/web/api.js`) that reuses the same rules as Discord. Set `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` and `WEB_SITE_URL` to switch it on; everything else, including Tailscale Funnel and Vercel setup, is in [docs/web.md](docs/web.md).

## Many servers

`MULTI_TENANT=true` makes one bot serve many booking servers. Each server gets its own database file (`data/tenants/<id>.db`), its own settings, backups and payment keys (entered by its owner with `/admin thanh-toan`, stored in that server's database and never in the shared environment), and its own license. `OWNER_IDS` is ignored in this mode: a server's owner is its administrator.

1. The operator issues a key: `npm run license -- issue --days 30 --plan standard` (add `--guild <server id>` to tie it to a server and start it at once). `list`, `show` and `revoke` are there too; licenses live in `data/master.db`.
2. The server's administrator runs `/kichhoat ma:BK-...`, then `/setup`. A second key adds its days after the current end. After the end date there are three days of grace with a warning, then the server gets a message saying why instead of any feature.
3. Commands are registered globally (`npm run deploy-commands` does it in this mode).
4. Buttons in private messages carry the server id at the end of their custom id, so a click is run in the right server.

`LICENSE_REQUIRED=false` serves every server the bot is in without a license.

## Languages

Everything a person is sent privately (answers, forms, buttons, private messages) is passed through a translation layer in their language: the one they chose with `/ngonngu`, otherwise their Discord app's language (English apps get English), otherwise Vietnamese. The catalog is `src/i18n/en.js`. Public panels, cards, log channels and staff tools stay in Vietnamese, and any text with no translation is shown in Vietnamese rather than hidden. `test/i18n.test.js` walks the main customer and player journeys in English and fails when any Vietnamese is left in what they see.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `DISCORD_TOKEN`, `CLIENT_ID` | yes | Bot token and application ID |
| `GUILD_ID` | yes, unless `MULTI_TENANT=true` | The one server this bot runs |
| `TIMEZONE` | no | Zone availability and bookings are read in (default `Asia/Ho_Chi_Minh`) |
| `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` | for payOS | The owner's payOS channel; all three are needed |
| `STRIPE_SECRET_KEY` | for Stripe | Stripe secret key |
| `PAYMENT_PROVIDER` | no | `payos`, `stripe` or `manual`, for new payments when more than one is on |
| `RETURN_URL` | no | Where a customer is sent after paying or cancelling |
| `OWNER_IDS` | no | Comma separated Discord user IDs that always count as owner (single-server mode; they must be on the server to see `sổ-tiền`) |
| `WEB_PORT`, `WEB_HOST`, `WEB_PUBLIC_URL` | no | The web server and the address shown in links |
| `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, `WEB_SITE_URL`, `WEB_DISCORD_INVITE` | for the public site | Discord login, cookie signing key, the site's address, optional server invite (see [docs/web.md](docs/web.md)) |
| `DASHBOARD_TOKEN`, `METRICS_TOKEN` | no | Fixed dashboard token; token for `/metrics` |
| `MULTI_TENANT`, `LICENSE_REQUIRED` | no | Many servers in one bot, and whether they need a license |
| `ALERT_WEBHOOK_URL` | no | Discord webhook that receives failure alerts |
| `DATA_DIR` | no | Where the database, heartbeat and backups live (default `data`) |
| `LOG_LEVEL`, `LOG_FORMAT` | no | `debug`, `info`, `warn`, `error`; `json` for one JSON object per line |

Business settings (fee percent, limits, durations, lead time, no-show grace, review window, cancellation tiers, strike rules, trust thresholds, peak windows, wallet packages, loyalty, extension and repeat limits, channel and role IDs) are one JSON document in the database, normalized by `src/settings.js` and edited with `/admin cai-dat`.

## Operations

- **Logs** are one line per event: readable text, or JSON with `LOG_FORMAT=json`.
- **Audit trail.** Every staff or owner command and button is written to the database with who and when (`/admin nhat-ky`); refused attempts are recorded too. Typed text is never stored in it.
- **Backups.** A copy of the database every day, seven kept (`data/backups`, one folder per server in many-server mode). Restore with the bot stopped: `npm run restore -- --list`, then `npm run restore -- 2026-10-05` (or a file path). The current database is kept next to it first, so a restore can be undone.
- **Upgrades.** An old database is upgraded in place when it is opened: new tables and columns are added, nothing is dropped.
- **Alerts.** Job failures, payment problems and missing-room problems go to `ALERT_WEBHOOK_URL` (the same text at most once per five minutes).
- **Checks.** `npm run smoke` against the real server, `npm run check` (syntax, unused imports, version) before a release.

## Project layout

```
src/
  config.js            environment, validated
  db.js                SQLite schema and upgrades (node:sqlite, WAL), transactions, one database per server
  tenancy.js           which server a piece of work belongs to; license.js, the license database
  settings.js          typed, normalized settings document
  i18n.js, i18n/       the translation layer and the English catalog
  log.js, audit.js, metrics.js, alerts.js, backup.js, heartbeat.js
  domain/              business rules, no Discord imports (bookings, ledger, pricing and quoting, coupons, wallet, waitlist, series, extensions, search, stats, dashboard, people, bank, export)
  pay/                 gateways (payOS, Stripe), orders, checkout, credentials
  discord/             helpers: router, permissions, access gate, rate limits, roles, rooms, cards, layout builder, panels, notifier, private-message tags
  commands/            one file per slash command
  flows/               buttons, modals and menus: age gate, players, booking, extend, series, availability picker, disputes, money
  events/              interactionCreate, voiceStateUpdate
  jobs/                payments, schedule, waitlist, series, refunds, roles, cards, leaderboard, digest, backup
  web/                 the small web server: webhook, dashboard, metrics
  index.js             builds the router, installs the notifier, starts the jobs and the web server, logs in
docs/design.md         specification
test/                  node:test suites with fake guild, client and interactions, an injected clock and stubbed gateways
scripts/               install-pi.sh, update.sh, smoke.js, restore.js, license.js, check.js
```

## Tests

```sh
npm test
```

Runs with `node --disable-warning=ExperimentalWarning --test`. The domain suites cover the rules (state machine, money invariants on every path, time zones, parsing, scheduling, pricing with peaks and coupons, the wallet, waiting list, repeats, extensions, search, statistics, both gateways with stubbed `fetch`, project hygiene). The Discord suites run the real router, commands, flows and jobs against a fake guild, client and interactions from `test/discord-fakes.js`. The web suite starts the real server on a free port. The many-server suite runs two fake servers side by side and checks that nothing leaks between them. The English suite checks the whole customer and player journey for leftover Vietnamese.

## Releases

Push a tag such as `v1.0.0` (or `v1.0.0-rc.1`): `.github/workflows/release.yml` runs the checks and the tests, refuses a tag that does not match `package.json`, and creates a GitHub release with the matching section of `CHANGELOG.md` as its notes.

## Not done

- Nobody has run it against a real Discord server and real payment keys yet (see "Status").
- The database is SQLite on one machine. The rules rely on synchronous transactions, so moving to PostgreSQL would be a rewrite of the data layer; one SQLite file comfortably carries thousands of bookings a day, and many-server mode gives every server its own file.
- Payment gateways: payOS and Stripe. Others (PayPal, MoMo) plug into `src/pay/gateway.js` but are not written.
- Slash command names and descriptions are Vietnamese only; the translation layer covers what the bot sends, not Discord's command picker.
