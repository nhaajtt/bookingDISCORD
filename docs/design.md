# bookingDISCORD: design and specification

This document is the specification for stage 2, the Discord layer. Stage 1 (this repository as it stands) contains the data layer and every business rule, fully tested, with no Discord imports in `src/domain`, `src/pay` or `src/settings.js`. Stage 2 adds `src/commands`, `src/events`, a few jobs and a thin layer of helpers that translate between Discord interactions and the domain functions listed in section 7. **Stage 2 must not re-implement any rule.** If a rule seems missing, the domain function is extended and tested first.

Code and this document are in English. Everything a person sees in Discord is Vietnamese. Sample replies below are the wording to use.

## 1. Product goals

A bot that runs a "book a friend" server almost by itself. Customers pay to book a player's time, to play a game together or just to talk. The owner only handles exceptions.

- **One bot instance per booking server** (single tenant). `GUILD_ID` and the owner's own payOS keys live in the environment. Nothing is shared between servers.
- **The bot never holds money.** Every payment lands in the owner's payOS account. The bot keeps an honest ledger of what the owner must hand over (player payouts) and send back (customer refunds). The owner does those by hand and marks each row paid, because payOS offers no payout or refund API the bot can use. Currency is VND, whole dong only.
- **Safe for work, adults only.** Every person confirms once that they are 18 or older (self-attestation, stored with a time). The content is gaming and conversation only. The rules, the booking guide and the error messages say so, and the bot never facilitates anything else.
- **No privileged intents.** The client asks for Guilds, GuildVoiceStates and GuildMessages only. Message content is never read, so the bot cannot moderate chat; moderation is by reports, staff and the rules.
- **Automated by default.** Reminders, private rooms, start detection, session end, rating prompts, refunds and payout bookkeeping are automatic. The owner's weekly work is described in section 13.

Out of scope for now: content generation features, licensing or plans (see section 17), automatic payouts and refunds, any use of message content.

## 2. People and roles

| Who | How the bot recognises them |
| --- | --- |
| Owner | Discord Administrator permission, or a user ID in `OWNER_IDS`. Only owners touch money (mark paid), settings and server setup. |
| Staff | The Discord role in `settings.roles.staffRoleId`, plus every owner. Staff approve players, resolve disputes, strike, blacklist and cancel bookings. |
| Player (provider) | A row in `players`. Status PENDING, ACTIVE, PAUSED, SUSPENDED or REJECTED. Active players hold the Player role. |
| Customer | Anyone who completed the 18+ confirmation. |

`isStaff(member)` and `isOwner(member)` live in one helper (`src/discord/permissions.js`) and every handler of a staff or owner action calls it first, before doing anything else, including on button and modal handlers (a hidden command is not a lock).

## 3. Server layout

`/admin setup` builds this layout idempotently (find by stored ID, else by name, else create) and stores every ID with `patchSettings({ channels, roles })`. Running it twice creates nothing twice. It never deletes anything.

### 3.1 Roles

| Role (suggested Vietnamese name) | Settings key | Given by | Permissions |
| --- | --- | --- | --- |
| Quản trị bot / Staff | `staffRoleId` | Owner, by hand | none beyond channel access; moderation is done through the bot and Discord's own moderation features |
| Đã xác nhận 18+ | `verifiedRoleId` | Bot, after the attestation modal | none (visibility only) |
| Player | `playerRoleId` | Bot, when staff approve an application | none (visibility only) |
| Player uy tín (trusted) | `trustedPlayerRoleId` | Bot, by `trustedRoleChanges` | none (cosmetic) |
| Khách quen (regular) | `regularCustomerRoleId` | Bot, by `regularCustomerChanges` | none (cosmetic) |

Safety rules for roles:

1. **Role-granting is never self-service.** No role picker, no reaction roles, no "choose your role" menu, no command that takes a role as an option from a normal user.
2. **Trust roles are given by the bot, only after the rules are met.** Verified: attestation recorded. Player: approved by staff. Trusted: at least 10 completed and an average of 4.5 or more while ACTIVE. Regular customer: at least 5 completed bookings and not blacklisted.
3. **The bot refuses to grant or remove any role that is not one of the five configured IDs**, and refuses to grant a role that has any of Administrator, ManageGuild, ManageRoles, ManageChannels, ManageMessages, KickMembers, BanMembers, ModerateMembers or MentionEveryone, even if configured. `/admin setup` reports such a role instead of using it.
4. The bot's own role is placed above the four bot-granted roles and below Staff, and has no Administrator. `/admin setup` checks the hierarchy and prints what to fix.
5. Roles are removed when their condition stops holding: Player on REJECTED, SUSPENDED or when the person leaves; Trusted when `trustedRoleChanges` says so; Verified never (the attestation is permanent), but a blacklisted user is banned or has channel access removed by staff.

Required bot permissions: View Channels, Send Messages, Embed Links, Manage Channels (private rooms), Manage Roles (the four roles), Read Message History, Connect (to read the voice member list it only needs the GuildVoiceStates intent, not Connect). Nothing else.

### 3.2 Categories and channels

Names are suggestions; the IDs are what matter. "Visible to" is enforced with permission overwrites on the category, with channels syncing from it.

| Category | Channel | Visible to | Who may write | Purpose |
| --- | --- | --- | --- | --- |
| BẮT ĐẦU (start) | `#luật-lệ` | everyone | nobody (bot posts) | Rules, and the button "Tôi đã đủ 18 tuổi" that opens the age modal. The only place a new member sees. |
| | `#hướng-dẫn` | Đã xác nhận 18+ | nobody | How booking works, prices, cancellation table (built from `settings.cancellation`), payment notes, safety, how to report. |
| | `#thông-báo` | Đã xác nhận 18+ | staff | Announcements. |
| ĐẶT LỊCH (booking) | `#danh-sách-player` | Đã xác nhận 18+ | nobody (bot posts profile cards) | One profile card per ACTIVE player with a Book button. |
| | `#đánh-giá` | Đã xác nhận 18+ | nobody (bot posts ratings) | Reviews, already sanitized. |
| | `#trò-chuyện` | Đã xác nhận 18+ | Đã xác nhận 18+ | Safe-for-work general chat. |
| PLAYER | `#đăng-ký-player` | Đã xác nhận 18+ | nobody | "Đăng ký làm player" button and the requirements. |
| | `#góc-player` | Player, Staff | Player, Staff | Player-only chat and announcements for players. |
| NHÂN VIÊN (staff) | `#duyệt-player` | Staff | bot | Application queue with Approve and Reject buttons. |
| | `#khiếu-nại` | Staff | bot, Staff | Open disputes with resolution buttons. |
| | `#sổ-tiền` | Owner only | bot | Money log and the payout and refund queues (section 12). |
| | `#nhật-ký` | Staff | bot | Booking events, strikes, suspensions, blacklist changes. |
| PHÒNG HẸN (rooms) | `lich-<id>-text`, `lich-<id>-voice` | The booking's customer and player, Staff (read only text, may join voice only after a dispute is opened), the bot | the two people | Created by the bot 10 minutes before the start, deleted 15 minutes after the end. |

A member who has not confirmed 18+ sees only `#luật-lệ`. Verified members never see staff categories.

Permission overwrites for a booking room (set at creation, no later changes except removing both people when the room closes):

- `@everyone`: deny View Channel.
- Customer and player: allow View Channel, Send Messages, Read Message History, Embed Links, Attach Files (text); View Channel, Connect, Speak, Stream (voice). Deny Mention Everyone, Create Invite.
- Staff role: allow View Channel and Read Message History on the text room; allow View Channel on the voice room, Connect only after `openDispute` (the dispute handler adds the overwrite and logs it).
- Bot: View, Send, Manage Channels, Manage Permissions on that channel.
- Voice room user limit 2 (3 once staff join).

### 3.3 Safety choices, summarised

- Age gate at the door; nothing is visible without it.
- Role-granting never self-service; trust roles given by the bot from facts in the database.
- Customer and player talk only inside the booking room, which staff can read when something is reported. Players are told in the rules not to move the conversation to private messages.
- Content is gaming and conversation only. Rules and the booking guide say this in plain words; breaking it is grounds for blacklisting.
- Everything that moves money is logged to `#sổ-tiền` with who, when, how much and why (section 12).
- Free text from users (display name, bio, reviews, dispute reasons) always goes through `sanitizeText`, so nobody can ping a role or everyone through the bot, and links are removed. Every message the bot sends sets `allowedMentions` to the specific users it means to ping (or none).
- Staff and owner actions check permissions inside the handler, and write an audit line to `#nhật-ký`.

## 4. Configuration

Environment (see `.env.example`): `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` (required); `TIMEZONE`, `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `RETURN_URL`, `OWNER_IDS`, `ALERT_WEBHOOK_URL`, `DATA_DIR`.

Settings document (SQLite table `settings`, edited with `/admin cai-dat`, always passing through `normalizeSettings`):

| Field | Default | Meaning |
| --- | --- | --- |
| `timezone` | env `TIMEZONE`, else Asia/Ho_Chi_Minh | Zone availability and booking times are read in |
| `ownerNotes` | empty | Free text shown to staff next to the payout queue (bank details reminders, who pays on which day) |
| `feePercent` | 10 | Platform fee, rounded to 1,000 dong per booking |
| `minRateVnd`, `maxRateVnd` | 20,000, 500,000 | Allowed hourly rate for players (multiples of 1,000) |
| `maxDurationHours` | 4 | Longest booking |
| `minLeadMin` | 60 | Earliest a booking can start from now |
| `maxAdvanceDays` | 30 | Furthest ahead |
| `unpaidExpireMin` | 30 | Payment window; the payOS link expires with it |
| `noShowGraceMin` | 15 | Wait after the start before a no-show can be declared |
| `reviewWindowHours` | 24 | Time to rate or to open a dispute after the end; payouts are held for this long |
| `maxActiveBookings` | 3 | Per customer |
| `strikeLimit`, `strikeWindowDays` | 3, 30 | Suspension rule |
| `cancellation` | 24h:100, 2h:50, 0h:0 | Refund tiers for customer cancellation |
| `trusted` | 10 completed, 4.5 average, regular customer at 5 | Thresholds for the trust roles |
| `channels.*`, `roles.*` | null | IDs filled in by `/admin setup` |

A settings change never alters existing bookings: price and fee are fixed when the booking is created; cancellation tiers and windows are read at the moment of each action.

## 5. Data model (SQLite, `node:sqlite`, WAL, created idempotently)

`settings`, `players`, `availability`, `bookings`, `ledger`, `strikes`, `blacklist`, `disputes`, `attestations`, `orders` exactly as listed in the brief, with these additions: `ledger.paid_by`, `strikes.cleared_at`, unique indexes `ledger(booking_id, kind)`, `strikes(user_id, booking_id, reason)` and a partial unique index allowing one OPEN dispute per booking, and CHECK constraints on every status column. `bookings.reminders_sent` is a JSON object of "this scheduled action was done" timestamps (reminders, rooms opened, rating asked, review window closed, rooms closed). There is no licensing table in stage 1.

Time is stored as epoch milliseconds in UTC everywhere. Availability is stored as weekday (0 is Sunday) and minutes from local midnight, interpreted in `settings.timezone`.

### 5.1 Booking state machine

```
AWAITING_PAYMENT --pay--------------> CONFIRMED --start---------> IN_PROGRESS --complete--> COMPLETED
      |  \--expire (30 min)--> EXPIRED     |  \--noShowPlayer---> NO_SHOW_PLAYER     |  \--dispute--> DISPUTED
      \--cancel--> CANCELLED               |  \--noShowCustomer-> NO_SHOW_CUSTOMER   \--cancel (staff)--> CANCELLED
                                           \--cancel--> CANCELLED
COMPLETED, NO_SHOW_PLAYER, NO_SHOW_CUSTOMER, IN_PROGRESS --dispute--> DISPUTED
```

The authoritative version is the frozen `TRANSITIONS` table in `src/domain/bookings.js` (action, from, to, allowed actor roles). Actors are `customer`, `player` (both checked against the booking), `staff`, `system`. An illegal move throws `ILLEGAL_TRANSITION`, a wrong actor throws `FORBIDDEN_ACTOR`. A resolved dispute leaves the booking in DISPUTED; the outcome lives in the dispute row.

Time guards: a session starts from 10 minutes before its time until its end; the system ends it only at its end (staff can end earlier); no-show only from start plus grace; customers and players cannot cancel after start plus grace; staff and system can always cancel.

## 6. Money rules (all in `src/domain/ledger.js`)

For every booking the rows add up to exactly the amount the customer paid, nothing is negative, and a kind appears once per booking (unique index). Let `price`, `fee` be fixed at creation and `R` the refund:

- `REFUND = R` to the customer.
- Kept part `K = price - R`. `FEE_INCOME = floor(fee * K / price)`, `PLAYER_PAYOUT = K - FEE_INCOME`.
- So: completed or customer no-show is `R = 0` (fee and share exactly as quoted); player no-show, player or staff cancellation and "refund the customer" are `R = price` (no fee, no payout); customer cancellation uses the tiers (100, 50 or 0 percent, boundaries favour the customer: exactly 24 hours is the top tier); a split dispute uses the chosen percent.
- `FEE_INCOME` rows are born PAID (the owner already holds that money). `PLAYER_PAYOUT` and `REFUND` rows are OWED until the owner marks them paid.
- **Payout hold.** A payout cannot be marked paid until `reviewWindowHours` after the booking ended, and never while the booking has an open dispute. `markPaid(..., { force: true })` overrides only the hold and is owner only, and logged.
- **Late payment.** If the order is paid after the booking expired or was cancelled unpaid, a full REFUND row is written (`late_refund` event). The booking is not revived.
- **Idempotency.** Writing a settlement twice writes once; transitions are compare-and-swap on the status inside a database transaction together with the money rows.

## 7. Domain API the Discord layer calls

All functions are synchronous except where marked, take `now` (epoch ms) explicitly, and throw `DomainError` with a stable `code` and a Vietnamese `message` that is safe to show to the person who caused it. The handler replies with `error.message` and logs anything that is not a `DomainError`. `settings` is optional everywhere and defaults to the stored document.

| Area | Function | Notes |
| --- | --- | --- |
| Age | `attest(userId, now)`, `hasAttested(userId)`, `isAttestPhrase(text)`, `ATTEST_PHRASE` | The phrase is "TÔI ĐÃ ĐỦ 18 TUỔI", compared ignoring case and accents |
| Players | `applyAsPlayer({ userId, displayName, games, rateVnd, bio, languages }, now)` | Needs attestation; returns PENDING player |
| | `approvePlayer(userId, staffId, now)`, `rejectPlayer(userId, staffId, reason, now)` | PENDING only |
| | `pausePlayer(userId)`, `resumePlayer(userId)`, `suspendPlayer(userId)` | |
| | `updateProfile(userId, patch)`, `setProfileMessage(userId, messageId)`, `getPlayer`, `listPlayers({ status, game })` | |
| | `setAvailabilityText(userId, text)` returns `{ ok, slots, errors }` | Stores only when fully valid |
| | `parseAvailability(text)`, `formatAvailability(slots)`, `getAvailability(userId)` | |
| Booking input | `parseLocalDateTime(text, timeZone, now)`, `parseDurationText(text)`, `formatVnd(n)`, `formatLocal(ms, timeZone)` | For the booking modal |
| Pricing | `quote(rateVnd, durationMin, feePercent, limits?)` | For the confirmation preview |
| Bookings | `createBooking({ customerId, playerId, game, startAt, durationMin }, now)` | Returns AWAITING_PAYMENT booking |
| | `pay(bookingId, now, amountPaid?)` | Called by the payment job only |
| | `expireUnpaid(bookingId, now)`, `start(bookingId, actor, now)`, `complete(bookingId, actor, now)` | Scheduler |
| | `cancel(bookingId, actor, now, { reason })` returns `{ booking, refundVnd, percent, strike }` | |
| | `noShow(bookingId, "player" or "customer", actor, now)` returns `{ booking, refundVnd, strike }` | |
| | `openDispute(bookingId, actor, reason, now)`, `resolveDispute(disputeId, outcome, staffId, note, now, { percent, strike, clearStrikes })` | outcome: `pay_player`, `refund_customer`, `split` |
| | `actorFor(booking, userId, { isStaff })`, `SYSTEM`, `staffActor(userId)`, `canTransition(from, action, role)` | Build the actor from a click |
| | `setRooms(bookingId, textId, voiceId, now)`, `getBooking`, `listBookings(filter)`, `cancelUpcomingForPlayer(playerId, actor, now)` | |
| | `refundFor(booking, cancelledBy, now, tiers)` | Preview of a cancellation before confirming |
| Orders | `createBookingOrder(bookingId, now)` returns `{ orderCode, amount, description, expiredAt }` | Then call `createPaymentLink` and `setCheckoutUrl` |
| | `createPaymentLink({ orderCode, amount, description, returnUrl, cancelUrl, expiredAt })` (async) | `src/pay/payos.js` |
| | `checkPayments(client, now)` (async) | The payments job; sets `client.notifyBooking` events |
| Ledger | `owedTo(userId)`, `pendingRefunds()`, `pendingPayouts(now, { includeHeld })`, `markPaid(ledgerId, by, note, now, { force })`, `summary()` | |
| Ratings | `recordRating(bookingId, customerId, stars, review, now)`, `playerRating(userId)` | |
| | `trustedRoleChanges(currentHolderIds)`, `regularCustomerChanges(currentHolderIds)` | Return `{ gain, lose }` |
| | `sanitizeText(text, max)` | For every free text before storing or showing |
| Strikes | `addStrike(userId, bookingId, reason, now)`, `liftSuspension(userId, by, now)`, `activeStrikeCount`, `listStrikes` | |
| | `addToBlacklist(userId, reason, byUserId, now)`, `removeFromBlacklist`, `isBlacklisted`, `listBlacklist` | |
| Schedule | `loadScheduleState(now, voice)`, `dueActions(state, now)`, `markActionDone(bookingId, type, now)` | Section 11 |
| Summary | `ownerSummary(now, { periodDays })`, `playerEarnings(userId, now)` | |
| Settings | `getSettings()`, `saveSettings(doc)`, `patchSettings(patch)`, `normalizeSettings(raw)` | |

Error codes the layer may see: `ILLEGAL_TRANSITION`, `FORBIDDEN_ACTOR`, `TOO_EARLY`, `TOO_LATE`, `NOT_FOUND`, `INVALID_INPUT`, `NOT_ATTESTED`, `BLACKLISTED`, `SELF_BOOKING`, `PLAYER_NOT_ACTIVE`, `GAME_NOT_OFFERED`, `BAD_START`, `IN_PAST`, `TOO_SOON`, `TOO_FAR`, `OUTSIDE_AVAILABILITY`, `PLAYER_BUSY`, `CUSTOMER_BUSY`, `TOO_MANY_ACTIVE`, `BAD_DURATION`, `BAD_RATE`, `UNDERPAID`, `ORDER_EXISTS`, `SETTLED_ALREADY`, `PAYOUT_HELD`, `OPEN_DISPUTE`, `NOT_RATEABLE`, `ALREADY_RATED`, `REVIEW_CLOSED`, `BAD_STARS`, `ALREADY_PLAYER`, `PLAYER_SUSPENDED`, `BAD_AVAILABILITY`. Their messages are in `src/domain/errors.js`.

## 8. Lifecycle of a player

1. **Age gate.** In `#luật-lệ` the button `age:open` opens modal `age:submit` with one text input ("Gõ đúng câu: TÔI ĐÃ ĐỦ 18 TUỔI"). Handler: `isAttestPhrase(text)`; if false reply ephemeral "Câu xác nhận chưa đúng. Hãy gõ: TÔI ĐÃ ĐỦ 18 TUỔI". If true: `attest(userId, now)`, grant `verifiedRoleId`, reply "Đã xác nhận. Bạn có thể xem các kênh đặt lịch rồi nhé. Server này chỉ dành cho người từ 18 tuổi trở lên và nội dung lành mạnh."
2. **Apply.** In `#đăng-ký-player` the button `pl:apply` (or `/player dang-ky`) opens modal `pl:apply:submit` with five inputs: display name, games or topics (comma separated, include "Trò chuyện" for chat), hourly rate in VND, short intro, languages. Handler: `applyAsPlayer(...)` (blacklist, attestation, rate limits, game count and text cleaning are enforced by the domain). Reply: "Đã nhận hồ sơ của bạn. Nhân viên sẽ duyệt sớm, bạn sẽ nhận được thông báo." Post an embed to `#duyệt-player` with the buttons `pl:approve:<userId>` and `pl:reject:<userId>`. Applying again while pending updates the application; after a rejection it reopens it.
3. **Staff decision.** `pl:approve:<userId>`: check staff, `approvePlayer`, grant `playerRoleId`, post the profile card in `#danh-sách-player` (embed: name, games, rate per hour with `formatVnd`, languages, bio, average and count, completed, "Uy tín" badge if trusted; button `pl:book:<userId>`), `setProfileMessage`, DM the player "Hồ sơ của bạn đã được duyệt. Dùng /player lich-ranh để nhập lịch rảnh." (DMs may fail, ignore the failure). `pl:reject:<userId>` opens modal `pl:reject:submit:<userId>` with a reason, then `rejectPlayer`, DM the reason, edit the queue message to show who decided and when.
4. **Availability.** `/player lich-ranh` (option `lich`, free text) or a modal: `setAvailabilityText`. On errors reply with the list of `errors`, one per line, plus the example. On success reply "Đã lưu lịch rảnh: <formatAvailability>. Giờ tính theo múi giờ <timezone>." A player with no availability cannot be booked (the booking validation refuses with `OUTSIDE_AVAILABILITY`), so the profile card shows "Chưa có lịch rảnh" until set.
5. **Profile changes.** `/player thong-tin` opens a modal prefilled from `getPlayer`, then `updateProfile`; refresh the card by editing `profile_message_id`.
6. **Pause and resume.** `/player tam-nghi` and `/player nhan-lai` call `pausePlayer` and `resumePlayer`; the card shows "Đang nghỉ" and its Book button is disabled while PAUSED. Existing bookings stay valid; to cancel them the player cancels each (a strike applies, so explain this in the confirmation).
7. **Earnings.** `/player thu-nhap` calls `playerEarnings(userId, now)` and replies ephemeral: "Đã hoàn thành: N buổi. Đánh giá: X sao (M lượt). Chờ chuyển: A (đang giữ đến hết thời gian khiếu nại: B). Đã nhận: C. Buổi tới: D."
8. **Suspension.** `addStrike` returns `suspended: true` on the third strike in 30 days. The handler then removes the Player role. Cancelling the player's upcoming bookings is not automatic, the owner decides: the handler posts to `#nhật-ký` "Player <name> bị tạm khoá do 3 cảnh cáo" with a button "Huỷ các lịch sắp tới và hoàn tiền" that staff press, and edits the profile card to "Tạm khoá". `liftSuspension` is `/staff mo-khoa`, which restores the role and clears the strikes.

## 9. Lifecycle of a booking

1. **Start.** The customer presses `pl:book:<playerId>` on a card (or `/datlich player:@x`). Check: not a bot, the customer holds the verified role (else reply with a pointer to `#luật-lệ`). Open modal `bk:new:<playerId>` with three inputs: game (placeholder shows the player's games), date and time (placeholder "DD/MM HH:mm", for example "12/10 19:30"), duration (placeholder "1, 1.5, 2 giờ").
2. **Create.** Modal handler: `startAt = parseLocalDateTime(when, settings.timezone, now)` (null: "Không hiểu ngày giờ. Ví dụ: 12/10 19:30"), `durationMin = parseDurationText(text)` (null: "Không hiểu thời lượng. Ví dụ: 1, 1.5 hoặc 90p"), then `createBooking({ customerId, playerId, game, startAt, durationMin }, now)`. Any `DomainError` is shown as is (past time, outside the player's free hours, double booking, limit of three, and so on). Defer the reply first; the whole flow can take a second or two.
3. **Payment link.** `createBookingOrder(booking.id, now)`, then `createPaymentLink({ orderCode, amount, description, returnUrl: config.returnUrl, cancelUrl: config.returnUrl, expiredAt })`, then `setCheckoutUrl`. If payOS is off or fails: `cancel(booking.id, SYSTEM, now)`, `closeOrder(orderCode, "FAILED")` and reply "Hệ thống thanh toán đang bận, bạn thử lại sau ít phút nhé." and alert the owner. On success reply ephemeral with an embed: player, game, local time (`formatLocal`), duration, price (`formatVnd`), "Thanh toán trong <unpaidExpireMin> phút, sau đó lịch tự huỷ." and a link button "Thanh toán" to the checkout URL, plus `bk:cancel:<id>`.
4. **Confirmation.** The payments job calls `pay` and then `client.notifyBooking({ kind: "paid", booking, order })`. The handler DMs the customer (fall back to the booking log channel with a mention) "Đã nhận thanh toán. Lịch #<id> với <player> lúc <time> đã được xác nhận.", DMs the player "Bạn có lịch mới: <customer> chơi <game> lúc <time>, <duration>.", and writes to `#nhật-ký` and `#sổ-tiền` ("Nhận <amount> cho lịch #<id>"). For `kind: "late_refund"` post to `#sổ-tiền` "Tiền về muộn cho lịch #<id> (<amount>), đã ghi nợ hoàn tiền" and tell the customer the refund is queued.
5. **Reminders.** `reminder24h`, `reminder1h` and `reminder10m` (from the schedule job) DM both people with the time and a reminder to be on time; each at most once.
6. **Rooms.** `openRooms`, 10 minutes before the start: create the private text room and voice room in the rooms category with the overwrites of section 3.2, `setRooms(id, textId, voiceId, now)`, post in the text room the welcome: "Chào <customer> và <player>. Buổi hẹn bắt đầu lúc <time>, kéo dài <duration>. Cả hai vào phòng voice nhé. Chỉ trò chuyện và chơi game lành mạnh. Có vấn đề, bấm Báo cáo sự cố." with buttons `bk:problem:<id>` and `bk:cancel:<id>`. Ping both users.
7. **Voice-presence start.** The schedule job builds the voice map from the voice room members (GuildVoiceStates). `start` is due when both are in the room: call `start(id, SYSTEM, now)` and post "Buổi hẹn đã bắt đầu, kết thúc lúc <end>."
8. **No-show.** `noShowCheck` carries `absent`. The handler re-reads the voice room membership once more (and waits one extra tick, so a person who joins in that minute is not penalised), then: `absent: "player"` calls `noShow(id, "player", SYSTEM, now)` and tells the customer "Player vắng mặt, bạn được hoàn 100%."; `absent: "customer"` calls `noShow(id, "customer", ...)` and tells both that the player is paid; `absent: "both"` calls `cancel(id, SYSTEM, now, { reason: "cả hai vắng mặt" })` (full refund, nobody struck). Suspension on the third strike follows section 8.
9. **Auto end.** `autoEnd` at start plus duration: `complete(id, SYSTEM, now)`, post "Buổi hẹn đã kết thúc, cảm ơn hai bạn.", disconnect nobody (leave the room open for 15 minutes).
10. **Rating.** `askRating` posts in the room and DMs the customer: "Bạn thấy buổi hẹn thế nào?" with buttons `bk:rate:<id>:1` to `bk:rate:<id>:5`. A star button opens modal `bk:rate:submit:<id>:<stars>` with an optional review. The submit handler calls `recordRating(id, userId, stars, review, now)`, replies "Cảm ơn bạn đã đánh giá!", posts the review to `#đánh-giá`, and refreshes the player's card. `autoComplete` (review window closed, no rating) edits the rating message to remove its buttons. A button at `bk:problem:<id>` stays on the message until the window closes.
11. **Report a problem.** `bk:problem:<id>` (customer, player or staff) opens modal `bk:problem:submit:<id>` asking for the reason, then `openDispute(id, actor, reason, now)`. Reply "Đã gửi báo cáo, nhân viên sẽ xem xét. Khoản tiền của buổi này được giữ lại cho đến khi có kết quả." Post to `#khiếu-nại` an embed with the booking, both people, price, the reason, the room links and three buttons: `dp:resolve:<disputeId>:pay_player`, `dp:resolve:<disputeId>:refund_customer`, `dp:resolve:<disputeId>:split`. Add the staff voice overwrite and keep the rooms (do not close them for a disputed booking).
12. **Dispute resolution (staff).** The pay and refund buttons call `resolveDispute(disputeId, outcome, staffId, note, now)` after a confirmation; `split` opens a modal for the percent refunded (default 50) and a note. Outcome texts: pay the player: "Khiếu nại đã xử lý: player được thanh toán đủ." refund: "Khiếu nại đã xử lý: bạn được hoàn 100%." split: "Khiếu nại đã xử lý: hoàn <p>% (<amount>), phần còn lại trả cho player." Optionally the staff choose to strike the side at fault or to clear strikes the booking caused (select menu on the confirmation). If the domain throws `SETTLED_ALREADY` (a payout was force-marked paid earlier) tell the staff to settle by hand and leave the dispute open. After resolving, close the rooms (delete both) and edit the queue message with the decision, staff and time. The result is also DMed to both people.
13. **Cancellation.** `bk:cancel:<id>` first shows the consequence using `refundFor(booking, actor.role, now, settings.cancellation)`: "Nếu huỷ bây giờ bạn được hoàn <p>% (<amount>)." (for a player: "Huỷ lịch sẽ hoàn 100% cho khách và bạn bị 1 cảnh cáo."), with `bk:cancel:yes:<id>`. Confirm calls `cancel(id, actor, now)`; tell the other side; if `strike.suspended`, section 8. An unpaid booking cancels without money. After start plus grace the domain refuses (`TOO_LATE`); the handler points the person to the report button.
14. **Expiry.** `expireUnpaid` from the schedule job calls `expireUnpaid(id, now)` and edits the payment message to "Lịch đã hết hạn thanh toán." The order stays pending until its 35 minute lifetime ends so a late payment is still found and refunded.
15. **After.** `closeRooms` 15 minutes after the end (and after a cancellation or no-show if rooms exist) deletes the rooms, then `markActionDone(id, "closeRooms", now)`. Deleting a room that is already gone counts as done.

## 10. Commands, buttons, modals

Every interaction handler: `deferReply({ ephemeral: true })` or `deferUpdate()` first, then work, then `editReply`. Use ephemeral replies for anything about money or a person's own data. A handler wraps domain calls in one try block: `DomainError` becomes `editReply(error.message)`; any other error is logged, alerted with `alert()` and answered with "Có lỗi xảy ra, thử lại sau nhé." Custom IDs are `<area>:<action>:<id>[:<extra>]`, at most 100 characters, and every handler re-checks who is clicking (never trust the ID alone).

### 10.1 Slash commands

Top-level commands are `/datlich`, `/lichcuatoi`, `/player`, `/staff`, `/admin`. Staff and admin commands are registered with `setDefaultMemberPermissions(0)` and still check inside the handler.

| Command | Who | Domain calls | Reply |
| --- | --- | --- | --- |
| `/datlich player:@user` | verified customer | opens the booking modal (section 9.1) | modal |
| `/lichcuatoi` | anyone verified | `listBookings({ customerId })` and `listBookings({ playerId })` | ephemeral embed, one line per booking: id, status in Vietnamese, player or customer, time, price; buttons for cancelling (`bk:cancel:<id>`) on cancellable ones |
| `/player dang-ky` | verified | opens the apply modal | modal |
| `/player lich-ranh [lich]` | player | `setAvailabilityText` | saved schedule or the error list |
| `/player thong-tin` | player | `getPlayer`, then `updateProfile` from the modal | "Đã cập nhật hồ sơ." |
| `/player tam-nghi`, `/player nhan-lai` | player | `pausePlayer`, `resumePlayer` | "Đã chuyển sang trạng thái nghỉ." and "Bạn đã nhận lịch trở lại." |
| `/player thu-nhap` | player | `playerEarnings` | section 8.7 |
| `/staff duyet` | staff | `listPlayers({ status: "PENDING" })` | queue with approve and reject buttons |
| `/staff khieu-nai` | staff | `listOpenDisputes`, `getBooking` | open disputes with resolution buttons |
| `/staff huy-lich id:N [ly-do]` | staff | `cancel(id, staffActor(userId), now, { reason })` | "Đã huỷ lịch #N, hoàn <amount> cho khách." |
| `/staff phat user:@u ly-do` | staff | `addStrike(userId, null, reason, now)` | count and whether the player was suspended |
| `/staff mo-khoa user:@u` | staff | `liftSuspension(userId, staffId, now)`, grant Player role back | "Đã mở khoá <name>." |
| `/staff cam user:@u ly-do` | staff | `addToBlacklist`, `suspendPlayer` if a player, then `cancelUpcomingForPlayer` after a confirm | "Đã cấm <name>." |
| `/staff bo-cam user:@u` | staff | `removeFromBlacklist` | "Đã bỏ cấm." |
| `/staff tong-ket` | staff | `ownerSummary(now)` | embed: today and next 7 days, week revenue and fee, pending applications, payouts, refunds, disputes |
| `/staff tien` | owner | `pendingRefunds()`, `pendingPayouts(now, { includeHeld: true })`, `owedTo` | the money queue (section 12) |
| `/admin setup` | owner | idempotent layout builder, `patchSettings` | report of what was created, found, or needs fixing |
| `/admin cai-dat` | owner | `getSettings`, `patchSettings` through modals per group (fee and limits; windows; cancellation tiers as lines "24h 100"; owner notes) | the new values |
| `/admin sao-luu` | owner | `backupDb()` | file name or "Hôm nay đã có bản sao lưu." |
| `/admin donhang` | owner | `recentOrders(10)` | table of recent payOS orders |

### 10.2 Buttons and modals

| Custom ID | Where | Who | What it calls | Result |
| --- | --- | --- | --- | --- |
| `age:open`, modal `age:submit` | `#luật-lệ` | anyone | `isAttestPhrase`, `attest` | verified role |
| `pl:apply`, modal `pl:apply:submit` | `#đăng-ký-player` | verified | `applyAsPlayer` | application posted to staff |
| `pl:approve:<userId>` | `#duyệt-player` | staff | `approvePlayer` | card posted, role granted |
| `pl:reject:<userId>`, modal `pl:reject:submit:<userId>` | `#duyệt-player` | staff | `rejectPlayer` | DM with reason |
| `pl:book:<userId>`, modal `bk:new:<userId>` | profile card | verified | `createBooking`, `createBookingOrder`, `createPaymentLink` | payment link |
| `bk:cancel:<id>`, `bk:cancel:yes:<id>` | room, DM, `/lichcuatoi`, payment message | customer, player, staff | `refundFor` preview, then `cancel` | refund amount |
| `bk:rate:<id>:<stars>`, modal `bk:rate:submit:<id>:<stars>` | room, DM | customer | `recordRating` | thanks, review in `#đánh-giá` |
| `bk:problem:<id>`, modal `bk:problem:submit:<id>` | room, DM | customer, player, staff | `openDispute` | ticket in `#khiếu-nại` |
| `dp:resolve:<disputeId>:<outcome>` (and a modal for split) | `#khiếu-nại` | staff | `resolveDispute` | decision recorded, rooms deleted |
| `dp:cancelupcoming:<playerId>` | `#nhật-ký` | staff | `cancelUpcomingForPlayer` | refunds queued |
| `mn:paid:<ledgerId>`, `mn:paid:yes:<ledgerId>` | `/staff tien` | owner | `markPaid(id, userId, note, now)` | row ticked, logged |
| `mn:force:<ledgerId>` | `/staff tien` (held payouts) | owner | `markPaid(..., { force: true })` after a second confirmation naming the amount | logged as forced |
| `pl:pause`, `pl:resume` | player replies | player | `pausePlayer`, `resumePlayer` | |

### 10.3 Events

- `interactionCreate`: one router; looks the custom ID prefix up in a table built from the command modules (each module exports `buttons`, `modals`, `selects`, `autocomplete` maps keyed by prefix). Autocomplete for `game` uses the player's games, for `player` uses `listPlayers({ status: "ACTIVE" })`.
- `guildMemberRemove`: not available without the members intent. Instead the schedule job notices missing members when an action fails (`Unknown Member`) and logs it. A player who leaves is paused by the layer the next time any action on them fails with "Unknown Member".
- `voiceStateUpdate` (GuildVoiceStates): optional fast path that triggers one schedule tick for the affected booking when someone joins its voice room, so a start is detected within seconds. The job alone is sufficient.
- `ready`: heartbeat and jobs start (already in `src/index.js`), then `client.notifyBooking` is installed.

## 11. Jobs

| Job (file in `src/jobs`) | Every | What it does |
| --- | --- | --- |
| `payments.js` (exists) | 30 s | `checkPayments(client)`; announces through `client.notifyBooking` |
| `schedule.js` | 30 s | `state = loadScheduleState(now, voice)`; for each `dueActions(state, now)` run the handler below, and mark flag actions with `markActionDone` only after the Discord side succeeded, so a failure is retried next tick |
| `roles.js` | 1 day | trusted and regular customer roles (below) |
| `cards.js` | 1 day | refreshes every active player's profile card (ratings and badges) and the guide's cancellation table |
| `backup.js` | 1 day | `backupDb()` |

`schedule.js` mapping (each action is `{ type, bookingId }`, `noShowCheck` adds `absent`):

| Action | Executed by | Marked with |
| --- | --- | --- |
| `expireUnpaid` | `expireUnpaid` | status |
| `reminder24h`, `reminder1h`, `reminder10m` | DM both people | `markActionDone` |
| `openRooms` | create rooms, `setRooms` | `setRooms` itself |
| `start` | `start(id, SYSTEM)` | status |
| `noShowCheck` | `noShow` or `cancel(SYSTEM)` per `absent` | status |
| `autoEnd` | `complete(id, SYSTEM)` | status |
| `askRating` | post rating buttons | `markActionDone` |
| `autoComplete` | remove rating buttons | `markActionDone` |
| `closeRooms` | delete both rooms | `markActionDone` |

The voice map is `{ [bookingId]: [userId, ...] }` taken from `voice_channel_id` members for CONFIRMED bookings near their time (only bookings between 10 minutes before start and end need it). `dueActions` is pure and idempotent: the same state and time give the same list; an executed action is excluded once marked (flags) or once the status moved (the rest).

`roles.js`: the members-intent is not used, so role holders are found without listing members. Candidates are all players plus every customer with at least one COMPLETED booking. For each candidate fetch the member by REST (`guild.members.fetch(id)`; a missing member is skipped) to see who holds each role, call `trustedRoleChanges(holders)` and `regularCustomerChanges(holders)`, then grant `gain` and remove `lose`. Holders that are not candidates are left alone (a role granted by hand is never removed by the bot unless it is in the lose list of a candidate).

All job and handler code takes the clock from one function (`now()`), defaulting to `Date.now`, so tests can fix it.

## 12. Money handling and the owner's queue

`/staff tien` (owner only) shows, from `pendingRefunds()`, `pendingPayouts(now)` and `pendingPayouts(now, { includeHeld: true })`:

1. **Refunds to send** (customer, amount, booking, reason note). Each has the button `mn:paid:<ledgerId>`. After the owner sends the money by bank transfer from the payOS dashboard or their bank app, they press it, confirm, and the row becomes PAID with who and when.
2. **Payouts to send**, grouped by player so one transfer covers several bookings (`owedTo(userId)` is the per-player total), showing `settings.ownerNotes`. Same button. Payouts still inside the complaint window are listed separately as "Đang giữ đến <time>" with no button (the force button is a second step with a warning).
3. A footer with `summary()`: owed and paid totals and fee income, so the owner can reconcile with the bank.

Every money event also writes one line to `#sổ-tiền`: payment received, late payment refunded, cancellation with the refund amount, settlement written, payout or refund marked paid (by whom, amount, note), forced payout, dispute outcome. The message is never deleted by the bot.

The bot cannot move money. It must say so wherever a customer might assume otherwise: refund confirmations read "Khoản hoàn đã được ghi nhận, chủ server sẽ chuyển lại cho bạn." and the guide states the usual delay.

## 13. The owner's weekly workload

Automated: availability checks, pricing, payment links, payment detection, confirmation, reminders, rooms, start and end, no-show handling, refunds and payouts written to the ledger, ratings, trust roles, strikes and suspensions, profile cards, backups, alerts about failures.

By hand:

1. **Payouts and refunds** (about once or twice a week): open `/staff tien`, make the bank transfers, press the buttons. This is the only recurring chore.
2. **Disputes**: staff read the booking room, decide among pay the player, refund the customer, split. Expect a few per month.
3. **Player applications**: approve or reject (staff).
4. **Bans and exceptions**: blacklist, lift suspensions, cancel bookings for a player who left, partial payments (below).
5. **Monthly**: look at `/staff tong-ket` and the backups folder.

## 14. Security model

- **Secrets** only in the environment (`.env` is git-ignored; the container reads it as `env_file`). Nothing is logged that contains a token or key. The payOS signature is computed on the bot only.
- **No inbound network**: there is no webhook; the bot polls payOS for its own open orders, so no public address and no signature-verification surface exists.
- **Money integrity**: integer dong, single transaction per transition, compare-and-swap status, unique indexes on ledger rows, order flip as the guard for payment settlement, payout hold, no payout during a dispute.
- **Authorization** is checked server side in every handler: staff and owner by role or ID; customer and player by comparing the clicking user with the booking (`actorFor`). Custom IDs are never trusted.
- **Input**: all free text through `sanitizeText`; parse functions return null or throw `DomainError`; length limits on every modal field.
- **Mentions**: every send sets `allowedMentions`.
- **Least privilege**: no Administrator for the bot, no privileged intents, role grant allowlist and a permission blacklist for roles (section 3.1).
- **Privacy**: stored per person is only the Discord ID, display name and profile for players, bookings and the age confirmation time. Nothing from message content. Reviews are shown publicly only after sanitizing. A deletion request is handled by the owner by hand.
- **Rate limits and abuse**: at most three active bookings per customer; unpaid bookings hold a slot for 30 minutes only; staff can blacklist.

## 15. Failure modes

| Failure | Behaviour |
| --- | --- |
| payOS down when creating a link | Booking cancelled by the system, order closed FAILED, customer told to retry, owner alerted. |
| payOS down when polling | Error logged per order, retried every 30 s; the order lives 35 minutes, the booking 30. If still failing near expiry the owner is alerted so a payment is not missed. |
| Customer pays after expiry | `late_refund`: REFUND row for the whole amount, announced in `#sổ-tiền`. |
| Customer pays part of the amount | payOS does not report PAID (`getPayment` returns `amount` and `amountPaid`). If a link closes with `amountPaid > 0` and the order is not paid, the job alerts the owner and posts to `#sổ-tiền`; refunding the partial amount is a manual exception. |
| Bot is down during a session | On restart the next tick sees the real voice membership. Sessions past their end are completed with `ended_at` at the scheduled end. A person who came and left while the bot was down may be flagged absent: the handler waits one more tick before declaring a no-show, and the dispute button is the remedy. |
| Rooms cannot be created | The tick is retried until the start; if still failing 5 minutes after the start the owner is alerted and the customer and player are told to use a staff-created room; staff can start with `start(id, staffActor)`. |
| Room or message already deleted | Treated as done; the action is marked. |
| Double click or two jobs at once | Domain transitions are compare-and-swap, `markActionDone` returns false the second time, ledger rows are unique. Handlers defer first and ignore `ILLEGAL_TRANSITION` from a repeat. |
| DM closed | Ignored; important notices also go to the booking room or the log channel with a mention. |
| Role hierarchy wrong | `/admin setup` and the boot check report it; role grants fail with a clear log line instead of silently. |
| Database error | The transaction rolls back; the handler answers with the generic error and alerts. Daily backups in `data/backups` (seven kept); restoring is copying a file over `thauxbooking.db` with the bot stopped. |
| Owner changes the time zone | Availability was entered in the old zone; the change dialog warns and asks staff to tell players to re-enter. Existing bookings are absolute times and do not move. |
| Daylight saving zones | Day arithmetic assumes 24-hour days, exact for the default zone; documented limitation for other zones. |
| Player leaves the server | Section 10.3: paused when noticed; staff cancel upcoming bookings with `cancelUpcomingForPlayer`. |
| Payout force-marked, dispute later asks a refund | `resolveDispute` throws `SETTLED_ALREADY`; staff settle by hand. |

## 16. Testing plan for the Discord layer

Stage 1 already covers the rules (rules, state machine, money invariants, time zones, parsing, scheduling, payments with a stubbed `fetch`). Stage 2 tests the translation layer without a network, following the buildDISCORD style.

1. **Fake interaction factory** (`test/discord-fakes.js`): builds an object with `user`, `member` (roles as a Set, permissions with `has`), `guild` (channels map, `members.fetch`, `roles`), `options` (getUser, getString, getSubcommand), `customId`, `fields.getTextInputValue`, and recorders for `reply`, `deferReply`, `editReply`, `update`, `showModal`, `followUp`. Every reply is recorded so tests assert on text, ephemeral flag, components and `allowedMentions`.
2. **Fake client and guild**: channels with `send`, `delete`, `permissionOverwrites`, voice channels with `members`, a role cache; `client.notifyBooking` as a spy. A fake `fetch` for payOS exactly as in `test/payments.test.js`.
3. **Injected clock**: handlers and jobs read `now()` from a context object; tests pass a fixed value and advance it. The database is `DATA_DIR=:memory:` (call `closeDb()` between tests, as the helpers do).
4. **Permission matrix test**: for every staff and owner command and button, a normal member, a player and a customer are refused, staff pass the staff ones, only owners pass the money ones; button handlers are called directly with forged custom IDs for someone else's booking and refused.
5. **Flow tests**: age gate (wrong phrase, right phrase, role granted); apply, approve, card posted, reject with reason; availability valid and invalid text; booking happy path with a stubbed payOS (modal to payment link to `checkPayments` to confirmation messages); booking errors shown verbatim (past, outside hours, busy, limit); cancel with tier preview for each tier and for the player; schedule job over a simulated day (reminders once each, rooms created with the exact overwrites, start on voice presence, no-show variants, auto end, rating, rooms deleted); rating modal; dispute open and each of the three resolutions including the `SETTLED_ALREADY` path; suspension on the third strike; money queue, mark paid twice (second is a no-op reply), forced payout needs the second confirmation.
6. **Message tests**: every Vietnamese string used is checked for no raw `@everyone`, no unescaped user text, and that sanitizing is applied to user text embedded in embeds.
7. **Layout test**: `/admin setup` twice creates the same set of roles and channels once, stores all IDs, refuses a role with dangerous permissions, and reports a hierarchy problem.
8. **Contract test**: a list of the domain exports the layer uses, imported by name in one test, so a rename in stage 1 breaks a test rather than production.
9. **Static checks** (already in stage 1, keep running): no message-content intent, no em dashes, no secrets, every module imports.

## 17. Later gates and open points

- **Licensing**: single-server installs skip it. Many-server mode (stage 3, section 19) has licenses, activation with `/kichhoat` and an operator command line.
- **Partial payments** and **refund automation** depend on payOS capabilities; today both are manual exceptions.
- **Daylight saving zones** need real calendar arithmetic if the product is ever used outside Vietnam.
- A customer who disputes every booking, or a player who is rated unfairly, is a staff judgment call; the domain provides strikes, clearing strikes and the blacklist, but no automatic rule.

## 18. Stage 2 as built

Where the build differs from or adds to the text above:

- **Command names.** The owner's money queue is `/chuyentien` (not `/staff tien`), the earnings view is `/thunhap` and the availability command is `/lichranh` (top level instead of `/player thu-nhap` and `/player lich-ranh`). `/setup` is its own command (not `/admin setup`). `/player` keeps `dang-ky`, `thong-tin`, `tam-nghi`, `nhan-lai`; `/admin` has `cai-dat`, `sao-luu`, `donhang`.
- **Roles** are named Khách (verified), Người chơi (player), Trusted, Khách quen and Staff.
- **Extra channels.** `#xác-nhận-18` holds the age button next to `#luật-lệ`, `#đặt-lịch` holds the booking panel (a button that opens a menu of players), `#hỗ-trợ` is the support channel. The settings keys added for them are `ageGateChannelId`, `applyChannelId`, `bookChannelId`, `supportChannelId`, `playerCornerChannelId`, `startCategoryId`, `playerCategoryId`, `staffCategoryId`. The owner-only money channel also lets in the ids of `OWNER_IDS` that are on the server.
- **Digest.** A job posts a morning summary to the owner-only money channel (Monday: the week), once per local date, remembered in a small `kv` table.
- **Partial payments.** `checkPayments` now sends `{ kind: "partial", booking, order, amountPaid }` when a link closes with part of the money paid; the notifier writes to the money channel and alerts the webhook.
- **Confirmations.** Dispute decisions (except split, which has its own form) and every transfer mark go through a confirmation message; the dispute confirmation also offers the strike and clear-strikes options.
- **DM buttons.** Rating, problem and cancel buttons work in DMs (the router accepts those three prefixes without a guild; the handlers find the server themselves and still check the person against the booking).
- **Visibility of commands.** `/staff`, `/chuyentien`, `/admin` and `/setup` are registered with default permission 0, so only administrators see them until the owner allows `/staff` for the Staff role in Server Settings, Integrations. Handlers check permissions anyway.
- **Not built.** The optional `voiceStateUpdate` fast path (the 30 second tick is enough), and pausing a player who left the server when an action fails with Unknown Member (a failed room creation is retried and the owner is alerted five minutes after the start).

## 19. Stage 3 as built

Stage 3 adds the features that stage 2 listed as later gates or left out. The rules of stages 1 and 2 are unchanged: money still balances exactly on every path, every handler still checks who is clicking, the domain still has no Discord import. What changed and why:

- **One place makes a price.** `quoteBooking` (`src/domain/quoting.js`) takes the player's price for the game, counts half hours with the peak-hour surcharge, takes the fee on that list price, and takes a coupon out of the fee only. `list_price_vnd`, `discount_vnd` and `coupon_code` are stored on the booking, and `price_vnd` stays what the customer pays, so the ledger split (`price - fee` to the player) is untouched by discounts. A discount is capped at the fee, so it can never cut into the player's share.
- **Orders have a kind and a gateway.** `orders.kind` is BOOKING, EXTEND or TOPUP; `orders.provider` and `external_id` say which gateway made the link. `checkPayments` flips the order and fulfils it in one transaction: a booking is confirmed, an extension is applied, a top-up is credited. The gateway interface (`src/pay/gateway.js`) has `createLink`, `getPayment`, `closeLink` and, where the gateway can, `refund`. payOS cannot refund; Stripe can, and the `refunds` job sends refunds back with an idempotency key made from the ledger row and order.
- **The wallet is a sum of rows.** `wallet_tx` has signed amounts; the balance is their sum. Credits are keyed (`order_code` for top-ups, `booking_id` for spends and refunds) so nothing is credited twice. A booking paid from the wallet records `paid_with = 'WALLET'`; its refund row is written already PAID by "wallet" and a wallet row is added in the same transaction as the settlement, so there is never anything for the owner to transfer. A wallet-paid booking is extended from the wallet, a link-paid one by link, so a refund always goes back to where the money came from. The wallet is a liability, shown in the owner's summary with the cost of bonuses.
- **Extensions grow the same booking.** `applyExtension` adds duration, price and fee to the running booking, so ledger, payout, refund tiers and the end of the session follow with no special case. While an extension link is open its minutes are held (`pendingExtensions`), and `createBooking` refuses overlapping bookings. A payment that arrives after the session ended is reported for a manual refund.
- **Waiting list, repeats, search.** `waitlist` entries are notified one at a time per overlapping slot, with a hold (`waitlistHoldMin`) enforced in `createBooking` (`SLOT_HELD`). A weekly repeat (`series`) books only the first week; each later week is a reminder with a button carrying that week's start time, so nothing is charged or held without a click and a stale button books nothing. `searchPlayers` and `nextFreeSlot` are pure reads.
- **People.** Internal notes, a dispute flag (opened and rejected disputes inside a window), anonymous reports (reporter stored as a hash made with a secret kept in the database), an audit trail written by the router for every module marked `audited`.
- **Leaving the server.** Without the members intent, a player who left is found when a fetch answers Unknown Member (daily job, and when rooms cannot be created). The player is paused (`left_at` is set), upcoming bookings are cancelled with a full refund, and the owner is told. A player who returns is told to resume themselves.
- **Voice fast path.** `voiceStateUpdate` runs the scheduler for the one booking whose voice room was joined. The tick and the event never overlap (one run per server at a time).
- **Web server.** `src/web/server.js` (node:http, no dependency): webhook, dashboard, JSON and CSV, `/metrics`, `/healthz`. Dashboard access is a token (environment, or made by the owner and kept in that server's database), compared as hashes, with a per-address failure limit. A webhook is verified with the channel's checksum key and then only triggers a look-up at the gateway.
- **Many servers.** `db.js` keeps one SQLite file per tenant and follows `AsyncLocalStorage`: inside `runInTenant(guildId, fn)` every `getDb()` call (and so every domain function) reads and writes that server's file. The router resolves the server of each interaction (a private message carries it at the end of its custom ids, added by `sendDm` and by the router for answers), checks the license (`src/license.js`, `data/master.db`), and runs the handler inside the tenant. Jobs run once per licensed server the bot is in. Payment keys come from `paymentKeys()`: the environment in single-server mode, the server's own database in many-server mode. `OWNER_IDS` do not apply in many-server mode. In-memory state is keyed by server where booking numbers could collide.
- **Languages.** The handlers still write Vietnamese. `localizeAnswers` wraps `reply`, `editReply`, `followUp`, `update` and `showModal` of an interaction, and `sendDm` translates what it sends, both through `translate()` and the catalog `src/i18n/en.js` (exact lines, patterns with placeholders, then sentence and list parts, then the Vietnamese form of days, money and durations). A person's language is their choice, else the locale of their Discord app (remembered), else Vietnamese. Anything without a translation stays Vietnamese. `test/i18n.test.js` drives the customer and player journeys in English and fails on any Vietnamese that is left, so a new message must come with a catalog line.
- **Operations.** Structured logs (`src/log.js`), `scripts/restore.js` (validates a backup, keeps the current database first), `scripts/smoke.js`, `scripts/check.js`, an upgrade step in `db.js` that adds new columns and tables to an old file, and a release workflow.

### Decisions worth knowing

- Discounts are funded from the platform fee, not from the player, so a code never changes what a player earns. A code worth more than the fee is capped, and the answer says so.
- Weekly repeats ask for confirmation each week instead of charging in advance: a customer is never billed for a week they did not confirm, at the cost of one click.
- Wallet money is not withdrawable. The owner can correct a wallet by hand (`/admin dieu-chinh-vi`) when cash is handed back.
- Staff channels, public panels and cards stay Vietnamese. English covers what customers and players are sent privately.
- PostgreSQL was not adopted: the rules depend on synchronous transactions around several statements, and SQLite per server is enough for the intended scale.

### Still open

- A first run against a real Discord server and real payment keys.
- Gateways other than payOS and Stripe.
- Slash command names and descriptions in English (Discord command localizations).
