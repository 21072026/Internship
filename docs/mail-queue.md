# The mail queue

How outbound mail survives a relay that says "not now" (#2944, building on the
lane rules and send budget of #2941).

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
  and reminders, lifecycle and pipeline mail. Inline today.
- **BULK** — automated volume: digests, task nudges, reports, newsletters,
  announcements, surveys. Inline today.

`MAIL_QUEUE_LANES=TRANSACTIONAL,BULK` moves those two lanes onto the queue
outright; it is empty by default, and setting it back to empty restores inline
sending (with the retry path kept).

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
  recipient, the subject, the body and the minute: the same mail asked for twice
  in a minute is one row; a second reset link is a different body, so a
  different row.
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
  database. An environment with no SMTP configured also does nothing: every
  queued row would only fail there.
- **A tick** claims up to 5 rows at a time and runs for at most 25 seconds; the
  instrumentation timer never overlaps two ticks in one process.

Per row, in order:

1. Open the box. A row that cannot be opened (corrupt, or sealed under a
   rotated secret) is DEAD_LETTER.
2. Past `notAfter` → CANCELLED (`expired`), EmailLog FAILED.
3. The budget. `MAIL_METER_MODE=enforce` spends a token for the lane or puts
   the row back and ends the tick. `observe` (the default) never holds on rate,
   only behind an open breaker, and charges the meter. `off` does neither.
4. The opt-out gate again — a queued mail may be hours old, and the recipient
   may have switched the group off since. Opted out → CANCELLED, EmailLog
   SKIPPED.
5. Deliver through the pooled transport (one connection, reused).
6. Settle, with one guarded `updateMany` on `{ id, status: RUNNING, lockedBy:
   me }` so a row the reaper has handed to another worker is never overwritten:

| Outcome | Job | attempts | EmailLog |
|---|---|---|---|
| 250 | SUCCEEDED, box cleared | +1 | SENT |
| relay-wide (throttle, refused session, timeout, auth) | PENDING after the pause; **the rest of the batch is released too and the tick stops** | unchanged | DEFERRED |
| 4xx about the message | PENDING after a backoff (exponential, jittered, per lane) | +1 | DEFERRED |
| 5xx | FAILED, box cleared | +1 | FAILED |
| attempts exhausted (5) | DEAD_LETTER, box cleared | 5 | FAILED |
| the next try would land after `notAfter` | CANCELLED, box cleared | — | FAILED |

A relay-wide failure is never charged to the message: it says nothing about the
message, and charging it would dead-letter healthy mail during an outage. It
pauses the budget instead, on an escalating ladder (1, 2, 5, 15, 30 minutes by
default, `MAIL_THROTTLE_LADDER_SEC`); each delivered mail walks it one rung back
down.

Delivery is at least once: a container killed between the relay's 250 and the
settle sends that mail again once the claim expires (5 minutes). That window is
one statement wide.

## The breaker

The budget is *paused* when a throttle or a refused session has pushed it out
and no delivery has walked it back down yet (`pauseLevel > 0`). While it is
paused beyond what even critical mail may spend, a critical send skips the SMTP
attempt (it would only cost the person waiting its timeout) and goes straight to
the queue at priority 100, and the drain holds its rows until the pause runs out.
A budget that is merely busy never opens the breaker. `MAIL_METER_MODE=off`
never opens it.

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

The deploy scripts (`infra/deploy-prod.sh`, `infra/server/topic-deploy.sh`)
forward all of them from the environment file.

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
- `mail_meter.would_refuse` (observe mode) — what `enforce` would have held.

## Tests

- `scripts/test/mail-worker.test.mjs` — the settle table, the policy, the
  lifetime, the breaker and the envelope round trip (pure, with a coverage
  floor).
- `e2e/mail-queue.spec.ts` with `e2e/helpers/fakeSmtp.ts` — a small SMTP server
  the spec controls (accept, refuse at a given step with a given reply, or
  hang). The smoke case: a password reset sent while the relay answers
  `450 4.7.1` returns in under a second and is delivered after the retry.
