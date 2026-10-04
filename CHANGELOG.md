# Changelog

## Unreleased

**Revenue**
- Quiet-hour discounts (`/admin cai-dat`, "Giảm giá giờ vắng"): a percent off, at most 50, in windows like the peak ones.
- Membership plans (`/thanhvien`): bought from the wallet, a percent off every booking for a number of days; renewing early adds days.
- Every automatic discount, with any coupon, is taken out of the fee only, so a player's share never changes.
- Tips after a session (up to 2.000.000 đ, once per booking, from the wallet): the whole amount goes to the player as a `TIP` ledger row, payable at once. The ledger table is rebuilt once on upgrade to allow the new kind.
- Referral codes (`/gioithieu`): both sides get wallet credit after the newcomer's first session worth enough.
- Gift cards (`/quatang`) between wallets, and player suggestions (`/goiy`) with the reason for each pick.

**Trust and safety**
- A Verified badge set by staff (`/staff xac-minh`), an Emergency button in every room that alerts staff and owners and freezes a running session like a complaint, ratings of customers by players (staff only), and a risk level in `/staff xem-khach` with every reason listed.

## 1.0.0-rc.1 (stage 3: the full feature set)

Feature complete; waiting for a first run against a real server and real payment keys (see the README).

**Money**
- Stripe as a second gateway behind one interface (`src/pay/gateway.js`), chosen with `PAYMENT_PROVIDER`; Stripe refunds are sent back to the card automatically, with an idempotency key per ledger row and order (`refunds` job). Money that arrives late through Stripe is refunded the same way.
- payOS webhook (signed, only a nudge: the payment is always confirmed from payOS's own answer) and a `cancelPaymentLink` call.
- Prepaid wallet: top-up packages with a bonus, pay a booking from the wallet or by link (never both), refunds of wallet-paid bookings go back into the wallet, owner corrections, wallet credit and bonus cost in the owner's numbers.
- Loyalty points: earned on completed sessions, turned into wallet credit.
- `/chuyentien`: bank details per row, VietQR images with the amount and note filled in, CSV export of the queue, the whole ledger and all bookings. Customers and players save their account with `/nganhang`.
- Discount codes (`/magiamgia`): percent or fixed, uses, per person, minimum price, expiry; paid out of the platform fee so the player's share never changes; held by an unpaid booking and given back when it expires or is cancelled.
- A price per game and peak-hour surcharges (priced per half hour); `quoteBooking` is the one place a price is made.
- Duplicate payments, paid extensions that the session can no longer take, and half-paid links are reported for a manual refund instead of being swallowed.

**Booking**
- Extend a running session from the room (30 minute steps, as far as the player is free, minutes held while the link is open).
- Waiting list with a hold for the first person in line; weekly repeats with one confirmation button three days before each week; book again from the rating thanks and from `/lichcuatoi`.
- `/timplayer`: filter by game, price, rating, language and "free now"; five sorts; next free slot.
- Hours picker with menus (`/lichranh chon:true`); photos and a voice sample as links; per-game prices; profile cards with badges, hours and reliability.
- Leaderboards (`/bangxephang`, a monthly post), badges (top of the month, 50 and 100 hours, punctual, loyal customers).
- A session starts the moment the second person joins the voice room (voice event), not at the next tick; the two paths never overlap.
- A player who left the server is found (Unknown Member), paused, and their upcoming bookings are refunded.

**People and safety**
- Internal notes and a staff card per customer, a flag for customers who keep losing disputes, anonymous reports with a hashed reporter.
- Audit trail of every staff and owner action in the database (`/admin nhat-ky`).

**Platform**
- Web server (optional): owner dashboard with charts, JSON and CSV, `/metrics`, `/healthz`, the payOS webhook; token auth with per-address rate limiting.
- Many servers in one bot: a database per server, licenses (`/kichhoat`, `npm run license`), per-server payment keys, private-message buttons that carry their server.
- English and Vietnamese: a translation layer on everything a person is sent privately, `/ngonngu`, automatic from the Discord app language; a test fails when any Vietnamese is left in the English journeys.
- Structured logs, `npm run restore`, `npm run smoke`, `npm run check` (syntax, unused imports, version), old databases upgraded in place, release workflow that builds a GitHub release from this file.

**Changed**
- `OWNER_IDS` apply to single-server installs only.
- The booking form has two more optional fields (discount code, weekly repeat); the room welcome has an Extend button; `/lichcuatoi` has book-again buttons.
- The reminder message reads "Nhắc lịch #N, buổi hẹn với X: ..." so it can be translated.
- Payments job: one confirmed payment can buy a booking, an extension or a top-up.

## 0.2.0 (stage 2: the Discord layer)

- `/setup`: idempotent builder for the roles (Khách, Người chơi, Trusted, Khách quen, Staff), categories and channels, with permission overwrites rewritten on every run, panels edited in place, a role safety check (powerful permissions, hierarchy, bot permissions) and a report in Vietnamese. Nothing is deleted.
- Age gate: button, modal with the confirmation phrase, `attest()`, Khách role. Rules and guide posted by the bot; the guide shows the live cancellation tiers.
- Players: apply modal, staff queue with approve and reject (reason by modal), profile cards edited in place, `/lichranh` with Vietnamese parse errors, `/player` for profile, pause and resume, `/thunhap`.
- Booking: `/datlich`, the book button on cards and a menu of players, modal, quote, payOS link, cancel with a refund preview per tier, the payment notifier (confirmation, late payment refund, partial payment alert), private text and voice rooms, ratings by modal (also from DMs), `/lichcuatoi`.
- Scheduler job: reminders, rooms, start on voice presence, no-show with one extra tick, auto end, rating prompt, rating buttons removed, rooms closed; flag actions are marked only after the Discord side worked.
- Disputes: report by modal, ticket with three resolution buttons and a confirmation step (strike or clear strikes), split by modal, rooms kept during a dispute and closed after, `SETTLED_ALREADY` leaves the case open.
- Staff tools: `/staff` (queue, disputes, cancel, strike, lift suspension, blacklist, summary); suspension on the third strike removes the role, marks the card and offers a cancel-upcoming button.
- Money: `/chuyentien` queue with a button per row, held payouts apart with a force button behind a second confirmation, every step logged to the owner-only money channel; daily or weekly owner digest; `/admin` for settings, backup and recent orders.
- Daily jobs: Trusted and Khách quen roles (members fetched one at a time), card and guide refresh, backup.
- Safety: one access gate (blacklist, 18+, permissions) in every handler, rate limits, `sanitizeText` on every user text, `allowedMentions` on every send, private replies for personal data, role allowlist, no privileged intents.
- Stage 1 additions: more channel settings keys, a `kv` table, `getLedgerRow`, and the payments job now reports a link that closed with only part paid.
- 106 new tests with a fake guild, client and interactions.

## 0.1.0 (stage 1: domain and data)

- Project scaffold: ESM, Node 22.13 or newer, `discord.js` and `dotenv` only, Dockerfile and compose file with a heartbeat health check, CI for tests and the image build, Raspberry Pi installer and self-update scripts.
- Data layer: SQLite tables for settings, players, availability, bookings, ledger, strikes, blacklist, disputes, attestations and orders, created idempotently with CHECK constraints and unique indexes that back the idempotency rules.
- Availability parsing and formatting (`T2 19:00-23:00; CN 09:00-12:00`, spelled-out days, `19h30`), time-zone aware `isWithin` with midnight-crossing bookings split at midnight.
- Pricing in exact integer dong with a fee rounded to 1,000, and parsing of booking dates and durations typed in a modal.
- Cancellation policy with tiers from settings; player cancellations always refund in full and earn a strike.
- Booking creation rules and the booking state machine as an explicit transition table, with money written in the same transaction as the status change.
- The ledger: exact splits for completed, cancelled, no-show and disputed bookings, payout hold during the review window, idempotent `markPaid`, late-payment refunds.
- Ratings once per booking inside a window, sanitized reviews, trusted player and regular customer role rules.
- Strikes with automatic suspension, lifting, blacklist.
- `dueActions` scheduler decision function and `markActionDone`.
- payOS client and order handling copied and adapted from the sibling project, with `checkPayments` that settles each order exactly once.
- Owner summary and player earnings.
- `docs/design.md`: the specification for the Discord layer.
