# The mail queue

How outbound mail survives a relay that says "not now" (#2944, building on the
lane rules and send budget of #2941), and how transactional and bulk mail are
paced through it instead of being sent in bursts (#2951).

## The problem

Every mail this app sends goes through one SMTP account. A relay protects itself
with temporary refusals — `450 4.7.1 … too much mail`, `421 Try again later`, a
connection that is not accepted, a greeting that never comes. Before the queue,
`sendEmail()` treated a temporary refusal exactly like a permanent one: the mail
was recorded FAILED, the exception propagated, and almost every caller swallowed
it. A burst of reminders that hit the relay's per-minute limit lost the last few
mails every time, and a password reset sent during that minute was lost too.

## What happens now

`sendEmail()` returns `'SENT' | 'QUEUED' | 'SKIPPED'`.

| Situation | Result | EmailLog | What happens next |
|---|---|---|---|
| The relay accepts the mail | `SENT` | SENT | — |
| An opt-out, demo mode, no SMTP configured | `SKIPPED` | SKIPPED | — |
| A **temporary** failure, any lane: a throttle, a refused session, a timeout, a 4xx about the message | `QUEUED` | DEFERRED | the drain retries it |
| A **permanent** failure: a 5xx about the message | throws | FAILED | nothing — as before |
| A CRITICAL mail that takes longer than `MAIL_INLINE_TIMEOUT_MS` | `QUEUED` | DEFERRED | a queued copy waits 30 s; the send still in flight cancels it if it goes through |
| A CRITICAL mail while the relay is paused (the breaker) | `QUEUED` | DEFERRED | queued at priority 100, no SMTP attempt |
| A lane listed in `MAIL_QUEUE_LANES` | `QUEUED` | — until delivered | the drain sends it |

A caller that reports "did the mail go?" treats `QUEUED` like `SENT` (it is on
its way and will be retried) and only `SKIPPED` as "no". The routes that answer
with an `emailSent` flag read `result !== 'SKIPPED'`.

A mail that cannot be queued falls back to exactly the old behaviour: attachments
over 256 KB in total, a missing server secret, a database that is down.

### Lanes

The lane comes from the e-mail group taxonomy (`src/lib/emailGroups.ts`) and
nowhere else — `laneFor()` in `src/lib/mailDeliveryRule.ts`:

- **CRITICAL** — someone is waiting: sign-in links, password resets,
  verification, security notices, invitations, operator alerts. Always tried
  inline first, never for longer than the inline cap.
- **TRANSACTIONAL** — written to or about one person: messages, meeting invites
  and reminders, lifecycle and pipeline mail. Should arrive within seconds.
- **BULK** — automated volume: digests, task nudges, reports, newsletters,
  announcements, surveys. May take hours.

`MAIL_QUEUE_LANES=TRANSACTIONAL,BULK` moves those two lanes onto the queue
outright (#2951): the sender's call returns `QUEUED` as soon as the row is
written, and the drain sends it. It is empty by default — every lane inline, as
before — and setting it back to empty is the rollback (the retry path stays).
CRITICAL is never queued outright: a person is waiting for it.

A caller may move a mail to a **lower** lane, never a higher one
(`effectiveLane()`): a bulk invitation run passes `lane: 'TRANSACTIONAL'`, so a
paste of 300 addresses rides the paced lane instead of spending the critical
reserve inline. A single invitation stays CRITICAL.

## The queue

A queued mail is a `Job` row named `email.send` on the existing job queue
(`src/lib/jobs/queue.ts`). There is no separate outbox table.

- **The envelope is sealed.** The prepared mail — recipient, subject, body,
  headers, attachments — is encrypted with `secretBox` under the purpose
  `mail-outbox` and stored in `payload.box`. It carries password-reset and
  sign-in links, so a database dump must not be able to read it. The box is set
  to null in the same statement that writes any terminal state.
- **No address in the clear.** `payload.rcpt` is the sha256 of the lowercased
  address. It is what account erasure deletes by.
- **De-duplicated.** `Job.idempotencyKey` is the mail's natural key when the
  caller passes one (`dedupeKey`), otherwise a hash of the category, the
  recipient, the subject and a per-call nonce: one `sendEmail()` call queues at
  most one row, and two calls are two mails, as they were before the queue. The
  body is never hashed onto the row — a reset or sign-in mail's body carries
  its link.
- **Bounded in time.** `payload.notAfter` is the lane's maximum age (critical
  24 h, transactional 12 h, bulk 72 h) or the caller's own deadline when that is
  earlier — a password reset passes its token's expiry. Past it, the mail is
  cancelled rather than delivered late.
- **Tenant anchor.** `Job.orgId` is the recipient's organization, passed
  explicitly, never inherited from whichever request sent the mail.

## The drain

`POST /api/mail/drain` runs one tick of `drainOnce()` (`src/lib/mailOutbox.ts`).
`src/instrumentation.ts` calls it every 5 seconds on **every** replica.

- **No lease.** Rows are claimed with `SELECT … FOR UPDATE SKIP LOCKED`
  (`claim({ names: ['email.send'] })`), so two replicas take disjoint rows and
  more replicas only drain faster. The pace across replicas is the shared send
  budget's (`MailBudget`), which is a meter, not an election.
- **Credential.** The `x-cron-secret` header: `CRON_SECRET` where it is set;
  otherwise the instrumentation hook mints a random `MAIL_DRAIN_SECRET` inside
  the process at boot, so an environment without `CRON_SECRET` still drains its
  queue and nobody outside the process knows the value.
- **Kill switch.** `MAIL_WORKER_ENABLED=0` stops the tick and makes the route a
  no-op. The deploy canary runs with it, because it shares production's
  database. An environment with no SMTP configured (`SMTP_USER` unset) starts
  no tick at all, and the route does nothing there: nothing is ever queued on
  such an environment, and every queued row would only fail.
- **A tick** runs for at most 25 seconds; the instrumentation timer never
  overlaps two ticks in one process.

### Which rows a round claims (#2951)

Each round of a tick claims in bands, by `Job.priority` (`claim({ filter })`):

1. **The higher lanes** — every row at or above priority 50 (CRITICAL 100,
   TRANSACTIONAL 50), up to 5 at a time. A bulk backlog never stands in front
   of a message notification or a meeting reminder.
2. Only when none is due, **one BULK row** (priority below 50), and the next
   round looks at the higher lanes again.
3. **Fair sharing between the two worlds.** The bulk claim first asks for the
   world the last bulk row was *not* from (`bulkWorldOrder()`), then for any
   bulk row. While both products have bulk mail waiting, each gets every second
   slot; either gets all of them when the other has none. Every queued row
   carries its `payload.world`, read from the recipient's organization when the
   send did not already know it.

An idle queue costs three claims per tick: the higher lanes, the preferred
world's bulk, any bulk.

Per row, in order:

1. Open the box. A row that cannot be opened (corrupt, or sealed under a
   rotated secret) is DEAD_LETTER.
2. Past `notAfter` → CANCELLED (`expired`), EmailLog FAILED.
3. The budget. First the breaker (every mode but `off`): while a relay pause
   runs, the row goes back to the pause's end and the tick ends. Then
   `MAIL_METER_MODE=enforce` spends a token for the lane or puts the row back
   and ends the tick; `observe` (the default) never holds on rate and only
   charges the meter; `off` does neither. In enforce mode a BULK row past
   today's bulk share of `MAIL_DAILY_CAP` goes back to the next UTC midnight,
   and this process takes no more bulk rows until then — the higher lanes keep
   draining (see *The daily cap*).
4. The opt-out gate again — a queued mail may be hours old, and the recipient
   may have switched the group off since. Opted out → CANCELLED, EmailLog
   SKIPPED.
5. Deliver through the pooled transport (one connection, reused).
6. Settle, with one guarded `updateMany` on `{ id, status: RUNNING, lockedBy:
   me }` so a row the reaper has handed to another worker is never overwritten:

| Outcome | Job | attempts | EmailLog |
|---|---|---|---|
| 250 | SUCCEEDED, box cleared | +1 | SENT |
| relay-wide (throttle, refused session, timeout, auth) | PENDING after the pause, one second behind **the rest of the batch, which is released too; the tick stops** | unchanged (every 4th release of the same row: +1) | DEFERRED |
| 4xx about the message | PENDING after a backoff (exponential, jittered, per lane) | +1 | DEFERRED |
| 5xx | FAILED, box cleared | +1 | FAILED |
| attempts exhausted (5), retries and counted releases together | DEAD_LETTER, box cleared | 5 | FAILED |
| the next try would land after `notAfter` | CANCELLED, box cleared | — | FAILED |

A relay-wide failure is not charged to the message: it says nothing about the
message, and charging it would dead-letter healthy mail during an outage. It
pauses the budget instead, on an escalating ladder (1, 2, 5, 15, 30 minutes by
default, `MAIL_THROTTLE_LADDER_SEC`); each delivered mail walks it one rung back
down. Two limits keep a failure that only *looks* relay-wide from holding the
whole queue on one mail:

- a released row goes back one second behind the rest of its batch, so the
  next tick leads with another row of the same priority;
- every fourth relay-wide release of the same row (`payload.releases`) counts
  as one attempt, so a row is dead after at most 5 × 4 relay-wide failures.

And a 4.7.x policy reply at `RCPT TO` or `DATA` is read as being about that
recipient or that message (a retry), not the relay — only a `421` or rate
wording there pauses everybody.

Delivery is at least once: a container killed between the relay's 250 and the
settle sends that mail again once the claim expires (5 minutes). That window is
one statement wide.

## The daily cap (#2951)

`MAIL_DAILY_CAP` (optional; unset = no cap) is how many mails this
environment's channel should carry per UTC day. `MailBudget.dayKey` and
`dayCount` count **every metered send** of the channel, whatever its lane —
inline and drained, granted or only observed — against the database's UTC day,
in the same statement that spends or charges the token.

- **BULK** may only spend while the count is below **90 %** of the cap
  (`bulkDailyLimit()`). The spend's conditional UPDATE carries the condition,
  so two replicas cannot both take the last slot.
- **TRANSACTIONAL and CRITICAL** are counted but never stopped: a counter must
  not hold a password reset. The last 10 % is theirs.
- In enforce mode a capped BULK row is released to the next UTC midnight
  (`mail_outbox.daily_cap`); in observe mode the cap is only logged
  (`mail_meter.would_refuse` with `reason: 'daily_cap'`).
- `MAIL_BULK_DAILY_CAP` is the bulk channel's own (`SMTP_BULK_*`), falling back
  to `MAIL_DAILY_CAP`. A topic environment may set `TOPIC_MAIL_DAILY_CAP`.

## Natural keys and deadlines (#2951)

A queued mail's `Job.idempotencyKey` is its natural key when the sender has
one (`dedupeKeyFor()`), so a cron tick that fires twice, or two replicas
running the same schedule, queue it once; its `notAfter` is when it stops being
worth sending:

| Mail | Key | `notAfter` |
|---|---|---|
| Meeting reminder | `mrem:<meeting>:<user>:<start minute>` | the meeting's start |
| Guest reminder | `mgrem:<meeting>:<sha256(guest)>:<start minute>` | the meeting's start |
| Series reminder | `srem:<series>:<user>:<occurrence minute>:<lead>` | the occurrence's start |
| Unread digest | `digest:unread:<user>:<UTC hour>` | the lane's 72 h |
| Activity / mentor digests | `digest:activity-…:<user>:<UTC day>`, `digest:mentor-weekly:…` | the lane's 72 h |
| Weekly report reminder | `digest:weekly-report:<mentee>:<week start>` | the end of that week |
| Survey invitation / reminder n | `survey:<invitation>:<n>` | the link's expiry |
| Newsletter | `nl:<issue>:<sha256(address)>` | the lane's 72 h |
| Operator alerts | `ops:<kind>:<window start>` | the lane's 24 h |

The start minute is part of a reminder's key on purpose: a meeting moved to
another time is reminded again for the new one. A reminder still queued when
its meeting starts is CANCELLED (`expired`), never sent late.

**Operator alerts.** The delivery-health alert used to be throttled by a
per-process timestamp, so every replica and every restart sent its own. It is
now queued (`queueOnly`) under `ops:email-<reason>:<six-hour window>`: one copy
per window leaves, however many processes raise it. The dead-letter and
newsletter-hold alerts carry an hourly key.

**The unread digest** stamps `digestedAt` only on the lines of recipients whose
digest was SENT or QUEUED (and on muted lines, as before). A recipient whose
digest did not go out — opted out, or a send that failed for good — keeps the
lines for a later run; the digest looks back 7 days, which bounds both what is
re-read and the backlog a later digest can carry. An environment that never
delivers (demo, no SMTP) stamps everything, as before.

## Mass sends (#2951)

- **Newsletters** go one recipient at a time (the four-way parallelism is
  gone). A queued copy writes its `NewsletterSend` row as **QUEUED** and names
  it in the queued mail's `ref` (`nlsend:<issue>:<user>`); when the drain
  settles the mail, `settleMailRef()` (`src/lib/mailRefHooks.ts`) moves the row
  to SENT, FAILED or SKIPPED and moves the issue's tally from *sent* to *failed*
  or *skipped* when the copy did not arrive. A drain faster than the row's own
  insert is caught by `reconcileQueuedMail()` right after the insert.
- **Announcements** (`src/lib/announcementMail.ts`): the single unbounded
  `Promise.all` over every recipient is now one `sendEmail()` after another —
  with BULK queued, N enqueues in a row.
- **Bulk invitations** and bulk resends: one row at a time, on the
  TRANSACTIONAL lane.
- **What the admin is told.** Each of the three answers with a `mailQueue`
  block (`mailQueueNotice()`): how many mails this action queued, the backlog
  in front of them and a rough estimate — at the configured rate in enforce
  mode — which the screen renders as "N e-mails are queued and will be
  delivered over about X" (EN/TR/DE).

## The breaker

A throttle or a refused session sets `MailBudget.pausedUntil` to the end of the
current rung. While that moment has not passed, a critical send skips the SMTP
attempt (it would only cost the person waiting its timeout) and goes straight to
the queue at priority 100, and the drain holds its rows until the pause runs out.

The breaker reads the pause and nothing else — never `tat`. In observe mode the
meter charges `tat` for every send, so after a large burst it can sit hours
ahead with no pause at all; a breaker reading it would hold a password reset
until its link expired. A budget that is merely busy never opens the breaker,
and `MAIL_METER_MODE=off` never opens it.

When the pause runs out the breaker closes even though the rung is still raised:
the next mail is the probe. Delivered (inline critical or by the drain), it
walks the ladder one rung down; refused, it pauses again one rung higher.

## Delivery health

An outage no longer writes FAILED rows — the queue keeps the mail and writes
DEFERRED. So the delivery-health alert (`getEmailHealth()`) also counts the
DEFERRED rows since the last delivery: it fires when at least three were
written and the first of them is 30 minutes old with nothing delivered since (a
short throttle that clears does not alert), and the hourly stale check counts
deferrals as activity. A relay-wide deferral, inline or in the drain, and a
mail that expires in the queue both run the check.

## Erasure and retention

- **Erasure** (`src/lib/accountErasure.ts`) deletes every queued mail to the
  erased address by its hash — only the erased account's own rows while the
  address still belongs to another account in the other product.
- **Retention** (`mailOutbox` in `src/lib/retentionEntries.ts`): SUCCEEDED and
  CANCELLED mail rows are deleted after 7 days, FAILED and DEAD_LETTER after 30.
  A row still on its way is never touched.

## One door

`npm run check:direct-sendmail` (in CI) fails when a transporter's own send call
appears anywhere outside `src/services/emailService.ts` and the GitHub Actions
report scripts, which run outside the app. Every mail goes through
`sendEmail()`; that is what applies the budget, the queue, the opt-out gate and
the EmailLog row.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_WORKER_ENABLED` | `1` | run the drain on this process |
| `MAIL_QUEUE_LANES` | empty | lanes queued outright (`TRANSACTIONAL`, `BULK`) |
| `MAIL_INLINE_TIMEOUT_MS` | `5000` | the longest a critical mail holds the request (1000–30000) |
| `MAIL_METER_MODE` | `observe` | `enforce` makes the drain wait for a budget token; `off` disables the meter |
| `MAIL_RATE_PER_MIN`, `MAIL_BURST`, `MAIL_URGENT_RESERVE` | 2, 2, 1 | the budget (see `.env.example`) |
| `MAIL_BULK_*` | the primary values | the optional bulk channel's own budget |
| `MAIL_THROTTLE_LADDER_SEC` | `60,120,300,900,1800` | the pause ladder |
| `MAIL_DAILY_CAP`, `MAIL_BULK_DAILY_CAP` | unset (no cap) | mails per UTC day; BULK stops at 90 % |

The deploy scripts (`infra/deploy-prod.sh`, `infra/server/topic-deploy.sh`)
forward all of them from the environment file.

### Recommended per environment (#2951)

Production and preview use separate SMTP accounts, and each environment drains
its own queue against its own budget, so the numbers are per environment:

| | `MAIL_QUEUE_LANES` | `MAIL_METER_MODE` | rate | burst | reserve | `MAIL_DAILY_CAP` |
|---|---|---|---|---|---|---|
| production | `TRANSACTIONAL,BULK` | `enforce` | 5 | 2 | 1 | 2000 |
| preview | `TRANSACTIONAL,BULK` | `enforce` | 1 | 1 | 0 | 200 |
| topic `pr<N>` | `TRANSACTIONAL,BULK` | `enforce` | 1 | 1 | 1 | 50 |

Roll out on preview first, then production. Before switching production to
`enforce`, watch a few days of `observe` (below). Rollback: `MAIL_QUEUE_LANES=`
(empty) sends every lane inline again; `MAIL_METER_MODE=observe` stops the
drain from waiting for tokens.

## What to watch

The log lines carry the lane, the category, a reason code and a job id — never
an address, a subject or the relay's text:

- `mail_outbox.deferred` — an inline send failed temporarily and was queued
  (`kind` = throttle / relay / retry, `reason` = the reply code).
- `mail_outbox.inline_timeout` — a critical send outlived its cap.
- `mail_outbox.breaker_open` — a critical mail was queued without an attempt.
- `mail_outbox.drain` — a tick that did something: counts of sent, retried,
  released, dead, expired.
- `mail_outbox.relay_paused`, `mail_outbox.retry`, `mail_outbox.dead`,
  `mail_outbox.expired` — per row.
- `mail_outbox.settle_lost`, `mail_outbox.inline_late_duplicate` — the
  at-least-once window was hit; one mail may have gone out twice.
- `mail_outbox.enqueue_failed` — a mail could not be queued and fell back to
  FAILED.
- `mail_meter.would_refuse` (observe mode) — what `enforce` would have held;
  `reason` is `refused` (the rate) or `daily_cap` (a BULK mail past 90 % of
  the cap).
- `mail_outbox.daily_cap` — enforce mode put a BULK row back to the next UTC
  day.
- `mail_outbox.ref_settle_failed` — a queued newsletter copy settled, but its
  `NewsletterSend` row could not be updated (the mail itself is fine).

## Tests

- `scripts/test/mail-worker.test.mjs` — the settle table, the policy, the
  lifetime, the breaker and the envelope round trip (pure, with a coverage
  floor).
- `e2e/mail-queue.spec.ts` with `e2e/helpers/fakeSmtp.ts` — a small SMTP server
  the spec controls (accept, refuse at a given step with a given reply, or
  hang). The smoke case: a password reset sent while the relay answers
  `450 4.7.1` returns in under a second and is delivered after the retry.
- `scripts/test/mail-pacing.test.mjs` — lane routing, the claim bands and their
  in-memory twin, world alternation, the daily cap, the estimate and the
  natural keys (#2951).
- `e2e/mail-pacing.spec.ts` — a 30-recipient announcement is queued whole and
  delivered at a test rate; a meeting reminder past its start is cancelled; the
  unread digest does not stamp a skipped recipient. The smoke case: a password
  reset still goes inline, at once, behind a full bulk backlog.
