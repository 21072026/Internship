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
| A generated recipient address — a stand-in lead (`import.local`) or an erased account (`erased.local`), checked **first** (#2970, `unmailableRecipient()`) | `SKIPPED` | SKIPPED, `Unmailable address: placeholder_address` / `erased_address` | nothing: never queued, never held as a draft. A row queued before #2970 is cancelled by the drain (`lastError: 'unmailable'`) |
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
over 256 KB in total, a missing server secret, a database that is down. One
exception (#2951): a mail of a lane listed in `MAIL_QUEUE_LANES` that has to go
inline that way (typically an announcement or newsletter with an image over the
cap) still waits for its budget token under `enforce` — in the caller, up to
`INLINE_PACE_MAX_WAIT_MS` (2 min) per mail — so a photo broadcast is paced like
a queued one instead of N back-to-back sends. Past the wait, on a daily-cap
refusal or with the meter unreadable it goes anyway (`mail_inline.pace_overrun`)
and the meter is charged for it. Such a broadcast holds the admin's request for
roughly one token interval per recipient.

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
  to null in the same statement that writes a terminal state — except FAILED
  and DEAD_LETTER (#2953), which keep it until the mail's `notAfter` so an
  operator can retry it; the drain's once-a-minute housekeeping
  (`clearExpiredEnvelopes()`) removes it from such a row once `notAfter` has
  passed. At most 72 hours (the bulk lane's lifetime), and erasure still
  deletes the row by its recipient hash.
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
   slot; either gets all of them when the other has none. The preferred world
   turns on a bulk row actually **sent**, never on one claimed: under enforce
   mode most ticks claim a bulk row only to have the budget release it, and a
   flip per claim would follow the 5 s tick instead of the token — one world
   could then win every slot. Every queued row carries its `payload.world`,
   read from the recipient's organization when the send did not already know
   it.

A round starts with a plain, non-locking probe for the most urgent due row, so
an idle queue costs one SELECT per tick and no claim transaction; the
higher-lane claim runs only when the probe saw such a row due.

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
| 5xx | FAILED, box kept until `notAfter` (#2953) | +1 | FAILED |
| attempts exhausted (5), retries and counted releases together | DEAD_LETTER, box kept until `notAfter` | 5 | FAILED |
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
  to `MAIL_DAILY_CAP`. A topic environment reads the preview environment file,
  so it inherits preview's cap unless `TOPIC_MAIL_DAILY_CAP` is set **in that
  file** (see the recommended values below).

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
digest was SENT or QUEUED, or **refused for good** (a 5xx — the mailbox does
not exist), and on muted lines, as before. A permanent refusal is settled: an
unstamped line would rebuild a fresh digest under the next hour's key and
bounce off the same mailbox every hour for the whole lookback week. A recipient
who opted out, or whose send failed in a way a later run could get past, keeps
the lines; the digest looks back 7 days, which bounds both what is re-read and
the backlog a later digest can carry. The failure is logged with its class and
a hash of the recipient, never the relay's text. An environment that never
delivers (demo, no SMTP) stamps everything, as before.

## Mass sends (#2951)

- **The fan-out width follows the lanes** (`fanOutWidth()`): one at a time
  when the mail's lane is queued (each send is one enqueue), the four in flight
  the fan-outs always had when it is not — `MAIL_QUEUE_LANES` unset, the
  default and the rollback, keeps a large send's request (and the newsletter
  run the 15-minute cron would otherwise resume over the top of) as short as
  it was.
- **Newsletters**: a queued copy writes its `NewsletterSend` row as **QUEUED** and names
  it in the queued mail's `ref` (`nlsend:<issue>:<user>`); when the drain
  settles the mail, `settleMailRef()` (`src/lib/mailRefHooks.ts`) moves the row
  to SENT, FAILED or SKIPPED and moves the issue's tally from *sent* to *failed*
  or *skipped* when the copy did not arrive — unguarded, so a copy settled
  while a first run is still going takes the tally below zero for a moment and
  the run's final increment nets it out. A drain faster than the row's own
  insert is caught by `reconcileQueuedMail()` right after the insert; a row
  whose envelope cannot be opened settles its record FAILED too.
- **Announcements** (`src/lib/announcementMail.ts`): the single unbounded
  `Promise.all` over every recipient is now a bounded fan-out — with BULK
  queued, N enqueues in a row.
- **Bulk invitations** and bulk resends go on the TRANSACTIONAL lane when that
  lane is queued (`bulkInvitationLane()`), one row at a time; otherwise on the
  invitation's own lane, four at a time, as before.
- **What the admin is told.** Each of the three answers with a `mailQueue`
  block (`mailQueueNotice()`): how many mails this action queued and a rough
  estimate — at the lane's effective rate in enforce mode
  (`effectiveLaneRatePerMin()`: a reserve that swallows the whole burst halves
  it) — which the screen renders as "N e-mails are queued and will be
  delivered over about X" (EN/TR/DE). The estimate counts the caller's own
  organization's waiting mail only and the count itself is not returned: the
  queue is shared by every tenant of the environment, and one org's admin must
  not read another's mailing volume from it.

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

## Operations (#2953)

### The health block

`GET /api/health?jobs=1` carries a `mail` block next to `jobs` — but only for an
**operator**: the `HEALTH_TOKEN` holder or a super admin. A plain tenant ADMIN,
who may read the generic `jobs` counters, does not get it: it is every
tenant's mailing volume, the figure `mailQueueNotice()` keeps from tenants.

```json
"mail": {
  "lanes": {
    "CRITICAL":      { "pending": 0, "oldestPendingAgeSec": null },
    "TRANSACTIONAL": { "pending": 3, "oldestPendingAgeSec": 12 },
    "BULK":          { "pending": 140, "oldestPendingAgeSec": 5400 }
  },
  "running": 1, "deferred24h": 4, "dead": 0, "failed24h": 1,
  "breaker": { "primary": { "paused": false, "pausedUntil": null, "pauseLevel": 0, "outageSec": null } },
  "day": { "primary": { "count": 412, "cap": 2000 } },
  "meterMode": "enforce"
}
```

The lane is read from `Job.priority` (`laneOfPriority()`: ≥ 100 CRITICAL,
≥ 50 TRANSACTIONAL, the rest BULK — the bands `lanePriority()` writes), so the
counters group on an indexed column instead of reading JSON. The age is since
the mail was **queued**, not since it became due. `bulk` appears only when the
bulk server is configured. Counts, ages and instants — never an address, a
subject or a relay's text.

### The Queue tab

Settings → Email deliverability has two tabs: *Delivery* (what was there before) and
*Queue* (`src/components/admin/MailQueuePanel.tsx`, fed by
`GET /api/admin/mail-queue`): counts per lane and state, the relay pause per
channel, the mail that was not delivered and the mail that is waiting.

**Who sees it** (`queueScopeFor()` in `src/lib/mailOpsRule.ts`) — the queue is
the whole deployment's, both products and every tenant:

| Caller | Rows | Today's count vs. the cap |
|---|---|---|
| super admin | every row of an organization in their world, plus the rows with no organization when their world is the default one | yes |
| ADMIN of the deployment's default organization | that organization's rows only | no |
| any other ADMIN, every other role | none — 403 `mail_queue_operator_only`, and no tab | — |

A row with no organization is **not** the default organization's: a send that
names neither an org nor a user (an account or consent mail, a public form's
reply, an operator alert) is queued without one whatever tenant it concerns, so
only a super admin of the default world sees those.

A row is its lane, category, product, state, attempts, a reason **code**
(`reasonCodeOf()`: anything that is not code-shaped, or that reads like an
address, shows as `other`) and the
first 12 hex characters of the recipient's sha256 — enough to match a log
line's `rcpt`, nothing an address can be read back from. The sealed envelope
never leaves the server. A row outside the caller's scope answers 404, the
same as a row that does not exist.

**The two actions** (`applyQueueAction()` in `src/lib/mailQueueAdmin.ts`):

- **Retry** — a FAILED or DEAD_LETTER mail goes back to PENDING, due now, with
  `attempts` and the relay-release counter reset and `createdAt` set to the
  retry (it is re-enqueued: the waiting ages and the critical-waiting alert
  measure from there; the original time is in the AuditLog). Only while its
  `notAfter` has not passed (`409 expired`) and its envelope is still on the
  row (`409 no_envelope`). A newsletter copy's `NewsletterSend` row, settled
  FAILED when the mail died, is re-opened to QUEUED in the same transaction
  (`reopenMailRef()`, which also reverses the issue's sent/failed tally), so
  the delivery settles it SENT — or FAILED again.
- **Cancel** — a PENDING mail becomes CANCELLED (`cancelled_by_operator`), its
  envelope cleared; a newsletter copy's record settles FAILED and the ledger
  gets a SKIPPED row. A RUNNING row is a drain's and is never touched.

Each is ONE guarded `updateMany` on the state the read saw, and the AuditLog
row (`MAIL_QUEUE_RETRY` / `MAIL_QUEUE_CANCEL`, `orgId` = the mail's tenant, or
the operator's when the mail has none) is written in the same transaction only
when a row changed: two operators clicking at once make one change, and the
second gets `409 conflict`. A `mail_queue.retry` / `.cancel` ActivityLog line
follows.

### Alerts

`evaluateMailOps()` (`src/lib/mailOpsAlert.ts`) runs after every drain tick,
including one that failed:
the credentials flag every time (in memory), the two database facts at most
once a minute per process. Each alert is raised at most once per hour — its
mail is queued under `ops:<kind>:<hour>`, and the process remembers the key —
and writes a `mail_ops.alert` log line and ActivityLog row first:

| Kind | Fires when | Read from |
|---|---|---|
| `mail-critical-waiting` | the oldest CRITICAL mail still PENDING was queued (or retried) more than 5 minutes ago | `Job` (priority ≥ 100) |
| `mail-breaker-open` | a relay pause is running and the outage began more than 15 minutes ago | `MailBudget.pausedSince` |
| `mail-relay-auth` | the relay rejected our credentials (`ENOAUTH`; `EAUTH` unless the reply was a 4xx, such as a 454 temporary failure; a 5xx at the AUTH step) | the inline sender and the drain |

`MailBudget.pausedSince` is set by the first pause after a quiet spell, kept
while pauses follow each other within the ladder's top rung, and cleared by a
delivered mail. During an outage the alert mail itself waits on the queue with
everything else; the log line and the ActivityLog row are the durable signal.
The alerts ride on the drain's timer, so a drain that does not run at all
(`MAIL_WORKER_ENABLED=0`, a dead process) raises none: it shows as a growing
`oldestPendingAgeSec` in the health endpoint's `mail` block.

The daily dead-letter alert (`src/lib/jobs/dlqAlert.ts`) already counts every
job name; for `email.send` it now also says how many of them are mail and that
the Queue tab can retry those whose deadline has not passed.

### The mail sink (PR environments)

A topic environment (`pr<N>`) never spends the relay's budget.
`infra/server/topic-deploy.sh` starts one shared Mailpit container on the box
(idempotently; SMTP on `127.0.0.1:1025`, the web UI on `127.0.0.1:8025`, plus a
private docker network for a bridge-mode container — no public port) and gives
every topic container `MAIL_SINK_HOST`/`MAIL_SINK_PORT`.

With `MAIL_SINK_HOST` set, `emailService` sends every mail to the sink —
unless **every** recipient (to, cc, bcc and an explicit envelope, read with
nodemailer's own address parser so the check sees exactly the addresses the
mail is sent to; a value that is not one clean address never matches) is on
`MAIL_RECIPIENT_ALLOWLIST`
(comma list of addresses and exact domains; `TOPIC_MAIL_RECIPIENT_ALLOWLIST` in
the env file overrides it for topic environments), which still goes through the
real relay (`mailRouteFor()` in `src/lib/mailSinkRule.ts`). The choice is made
from the recipients alone, never from whether the sink is up: a sink that is
down fails the send like any relay failure — the mail is queued and retried
against the sink — and nothing ever falls back to the relay. Mail to the sink
still passes the environment's own send budget (the topic database's own
`MailBudget` row): with preview's numbers a topic environment's queued mail
reaches the sink at about one a minute, while critical mail goes inline at once.
Mailpit keeps the
last 2000 messages. To read them: `ssh -L 8025:127.0.0.1:8025 <box>` and open
`http://localhost:8025` (`infra/README.md` § The mail sink).

The demo container runs with `MAIL_WORKER_ENABLED=0`
(`infra/server/demo-refresh.sh`): it sends nothing, so it drains nothing.

## Erasure and retention

- **Erasure** (`src/lib/accountErasure.ts`) deletes every queued mail to the
  erased address by its hash — only the erased account's own rows while the
  address still belongs to another account in the other product.
- **Retention** (`mailOutbox` in `src/lib/retentionEntries.ts`): SUCCEEDED and
  CANCELLED mail rows are deleted after 7 days, FAILED and DEAD_LETTER after 30.
  A row still on its way is never touched.

## Suppressed addresses (#1692)

A queued mail can be hours old, so the drain re-checks the bounce/complaint
suppression list (`docs/EMAIL_DELIVERABILITY.md` § 2e) right after the
generated-address check and before the budget: a suppressed recipient's row is
CANCELLED (`lastError: suppressed`), its envelope cleared, and the EmailLog row
reads `SKIPPED` / `Suppressed: <REASON>` — for every lane, CRITICAL included.

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
| `MAIL_SINK_HOST`, `MAIL_SINK_PORT` | unset, `1025` | send to this SMTP sink instead of the relay (topic environments, #2953) |
| `MAIL_RECIPIENT_ALLOWLIST` | unset | with a sink: addresses / domains that still go through the relay |

The deploy scripts (`infra/deploy-prod.sh`, `infra/server/topic-deploy.sh`)
forward all of them from the environment file.

### Recommended per environment (#2951)

Production and preview use separate SMTP accounts, and each environment drains
its own queue against its own budget, so the numbers are per environment:

| | `MAIL_QUEUE_LANES` | `MAIL_METER_MODE` | rate | burst | reserve | `MAIL_DAILY_CAP` |
|---|---|---|---|---|---|---|
| production | `TRANSACTIONAL,BULK` | `enforce` | 5 | 2 | 1 | 2000 |
| preview | `TRANSACTIONAL,BULK` | `enforce` | 1 | 1 | 0 | 200 |
| topic `pr<N>` | `TRANSACTIONAL,BULK` | `enforce` | 1 | 1 | 0 | 50 |

A topic environment reads the **preview** environment file, so it takes
preview's lanes, mode, rate, burst and reserve as they are; only the cap has a
topic override, `TOPIC_MAIL_DAILY_CAP`, which must be added to that file
(`TOPIC_MAIL_DAILY_CAP=50`) — without it a topic environment inherits
preview's 200. A topic environment also drains against preview's SMTP account
with its own budget row, so the relay sees preview's rate plus up to 1/min per
open topic environment. A reserve as large as the burst (burst 1, reserve 1)
would halve the transactional and bulk rate, which is why both rows recommend
reserve 0 at burst 1.

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
- `mail_inline.pace_overrun` — a paced lane's mail that had to go inline (an
  image over the queue's cap) waited its 2 minutes, or hit the daily cap, and
  went anyway.
- `Unread message digest failed` — with `settled: true` the mailbox refused
  for good and the lines were stamped; the same `rcpt` hash every hour means
  a retryable failure is repeating.
- `mail_outbox.ref_settle_failed` — a queued newsletter copy settled, but its
  `NewsletterSend` row could not be updated (the mail itself is fine).
- `mail_ops.alert` (#2953) — one of the three operator alerts fired (`kind`,
  `criticalWaitingSec`, `outageSec`); `mail_ops.evaluate_failed` — the
  evaluation itself could not read the database.
- `mail_queue.retry`, `mail_queue.cancel` — an operator acted on a row
  (ActivityLog, with the AuditLog row beside it).
- `mail_outbox.envelope_sweep_failed` — the housekeeping that clears the
  envelope of a dead row past its `notAfter` could not run (it retries a
  minute later).

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
- `scripts/test/mail-ops.test.mjs` — the alert thresholds, the auth
  classification, the lane bands, the reason-code and fingerprint rules, which
  action applies to which row, who sees which rows, and the sink allowlist and
  routing (#2953).
- `e2e/mail-queue-admin.spec.ts` — the Queue tab's API and actions, the scope
  per caller (the smoke case: a tenant admin is refused, the default
  organization's admin sees only its own rows), the audit rows and the health
  block's shape. `e2e/authz-matrix.spec.ts` probes the routes for every role.
- `e2e/mail-ops.spec.ts` — the sink routing, an unreachable sink that never
  falls back to the relay, and the three alerts with their hourly key.
- `e2e/mail-pacing.spec.ts` — a 30-recipient announcement is queued whole and
  delivered at a test rate; a meeting reminder past its start is cancelled; the
  unread digest does not stamp a skipped recipient. The smoke case: a password
  reset still goes inline, at once, behind a full bulk backlog.
