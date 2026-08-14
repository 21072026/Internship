# Email deliverability & inbound replies

This app's email is its backbone (invitations, verification, password reset,
reminders, digests, mentor↔mentee messages). Two things must work:

1. **Outbound** — our mail actually reaches inboxes (especially Gmail).
2. **Inbound** — a reply to a message email comes back into the app's Messages.

## 1. The 550-5.7.26 error (SPF/DKIM)

```
550-5.7.26 Your email has been blocked because the sender is unauthenticated.
Gmail requires all senders to authenticate with either SPF or DKIM.
DKIM = did not pass   SPF [crm.ersah.in with ip 212.132.111.125] = did not pass
```

This is **not an application bug** — it's DNS/mail-server configuration for the
sending domain. Gmail (since Feb 2024) hard-rejects mail from a domain that
passes neither SPF nor DKIM. Fix all of the following on the domain that
`SMTP_FROM` uses (`noreply@crm.ersah.in`) — in the DNS zone and the Plesk mail
server:

- **SPF** (DNS TXT on `crm.ersah.in`): authorize the sending IP/host, e.g.
  `v=spf1 a mx ip4:212.132.111.125 ~all`. Exactly one SPF record.
- **DKIM**: enable DKIM in Plesk (**Mail → Mail Settings → sign outgoing mail
  with DKIM**), then publish the generated public key as the
  `default._domainkey.crm.ersah.in` TXT record. Verify the selector Plesk uses.
- **DMARC** (DNS TXT on `_dmarc.crm.ersah.in`): start monitoring, e.g.
  `v=DMARC1; p=none; rua=mailto:postmaster@ersah.in`.
- **PTR / reverse DNS**: the sending IP (`212.132.111.125`) should resolve back
  to the mail hostname, and that hostname's A record back to the IP.

DNS changes take up to a few hours to propagate.

## 2. How to test outbound health (free, reply-based)

Use the in-app probe: **Admin → Settings → Email deliverability**. It shows the
live SMTP connection status and lets you send a real test email to any address.
Point it at one of these free services:

- **`check-auth@verifier.port25.com`** — send an email; it **replies** with a
  full report: SPF, DKIM, DomainKeys and SpamAssassin results. No signup. The
  reply goes to the `SMTP_FROM` mailbox (`noreply@crm.ersah.in`) — read it there.
- **[mail-tester.com](https://www.mail-tester.com)** — it gives you a one-time
  address like `test-xxxx@srv1.mail-tester.com`; send to it, then open the page
  to see a 0–10 score with the exact SPF/DKIM/DMARC/content findings.
- **MxToolbox** `ping@tools.mxtoolbox.com` — replies with deliverability info.
- Or simply send to a personal **Gmail** address and check: it lands in the
  inbox (not spam), and "Show original" shows `SPF: PASS` and `DKIM: PASS`.

A quick CLI cross-check of the DNS records:

```bash
dig +short TXT crm.ersah.in            # SPF
dig +short TXT default._domainkey.crm.ersah.in   # DKIM
dig +short TXT _dmarc.crm.ersah.in     # DMARC
dig +short -x 212.132.111.125          # PTR
```

## 2b. When SPF/DKIM/DMARC all pass and mail *still* lands in spam

Authentication is a gate, not a reputation. Passing it stops the hard
`550-5.7.26` rejection in §1; it does **not** get you into the inbox. Those are
two different problems with two different fixes, and it is easy to spend days on
the first while suffering from the second.

**Audit of the sending domain (2026-08-09)** — everything in §1 is already
correct in production:

| Check | Value | Verdict |
|-------|-------|---------|
| SPF (`crm.ersah.in` TXT) | `v=spf1 a mx ip4:212.132.111.125 ~all` | ✅ present, single record |
| DKIM (`default._domainkey`) | RSA 2048 public key published | ✅ |
| DMARC (`_dmarc.crm.ersah.in`) | `v=DMARC1; p=none; rua=…` | ✅ (monitoring) |
| PTR | `212.132.111.125` → `s.ersah.in` → `212.132.111.125` | ✅ forward-confirmed |
| Spamhaus ZEN / Barracuda | not listed | ✅ clean |

So when mail from this box still lands in spam, the remaining variable is
**sender reputation**: a single small VPS IP that sends a handful of messages a
day has no sending history, and Gmail/Outlook treat an unknown low-volume IP
with suspicion no matter how well it authenticates. You cannot fix that with
DNS — reputation is earned by volume and engagement this deployment will never
have on its own.

### The fix: relay through a shared reputation pool

Send through an ESP instead of straight from the Plesk box. Their pools carry
years of accumulated reputation, and this app talks plain SMTP
(`nodemailer`, `src/services/emailService.ts`), so it is an **env-var change
with no code**: point `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` at
the provider and leave `SMTP_FROM` as the `crm.ersah.in` address.

Free tiers, as of 2026-08 (verified against the providers' own pricing pages):

| Provider | Free tier | Daily cap | Paid entry | Notes |
|----------|-----------|-----------|------------|-------|
| **Brevo** | 300/day, no expiry, no card | 300/day (campaigns **+** transactional share one budget) | ~$25/mo for 40k | Best fit here: the cap is far above this app's volume |
| Resend | 3,000/month | **100/day** | $20/mo for 50k | SMTP relay on every tier, 1 domain on free |
| Amazon SES | 3,000/mo for the first 12 months | — | $0.10 per 1,000 | Cheapest at scale, but starts in a sandbox that needs a production-access request |
| MailerSend | 500/month (the old 3,000 tier became a paid $7/mo plan in Dec 2025) | 100/day | $7/mo | No longer competitive on the free tier |

**Recommendation: Brevo's free tier.** 300/day comfortably covers this
deployment, it costs nothing, and the switch is four env vars.

### Migration checklist (Brevo)

**Order matters: DNS first, env vars second.** Steps 1–3 are DNS and were all
verified live on 2026-08-09, so the remaining work is step 4 onwards. Re-run
`./infra/check-mail-dns.sh` before flipping the relay on any future domain.

1. **Brevo code** (proves you own the domain). A TXT record on `crm.ersah.in`:
   `brevo-code:<your code>`.
   ✅ *Live as of 2026-08-09.*

2. **DKIM** — this is the one that actually authenticates the mail, and it is
   **mandatory**. Brevo publishes it as a **pair of CNAMEs** on the `brevo1` and
   `brevo2` selectors (not a TXT on `brevo._domainkey`, which is what most
   third-party guides describe — check the selector before concluding it is
   missing).
   ✅ *Live as of 2026-08-09:*
   ```
   brevo1._domainkey → b1.crm-ersah-in.dkim.brevo.com → brevo17.dkim.brevo.com  (k=rsa;p=…)
   brevo2._domainkey → b2.crm-ersah-in.dkim.brevo.com → brevo18.dkim.brevo.com  (k=rsa;p=…)
   ```
   The Plesk box keeps its own `default._domainkey` TXT — that one signs mail
   sent directly from the server and stays in place.

   Check the whole picture with `./infra/check-mail-dns.sh`, which probes every
   selector in both record types and exits non-zero while DKIM is missing.

3. **SPF — leave it alone.** `include:spf.brevo.com` is **not required** and
   should not be added: Brevo owns the Envelope Sender (Return-Path), so SPF is
   evaluated against *Brevo's* domain, not ours. DMARC alignment for
   `crm.ersah.in` therefore comes from **DKIM**, which is why step 2 is the
   blocker. An unnecessary `include:` only burns one of SPF's 10 DNS lookups.
   The existing record stays exactly as it is, since the Plesk box still sends
   nothing-else mail and still needs to be authorized:
   `v=spf1 a mx ip4:212.132.111.125 ~all`

> ⚠️ **Never switch `SMTP_HOST` before DKIM resolves** (satisfied here, but it
> is the rule for any future domain). Sending `From: noreply@crm.ersah.in`
> through a relay while the domain is only half-authenticated means the message
> carries no signature aligned with our domain — the relay may refuse it or
> rewrite the sender, and whatever does get out authenticates *worse* than what
> the Plesk box sends today. `check-mail-dns.sh` exits non-zero exactly in that
> state so it can gate the change.

4. Once `dig` returns the DKIM record, set the env vars in
   `/etc/internship-crm/prod.env`:
   ```bash
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587
   SMTP_USER=<the SMTP login from Brevo → SMTP & API>   # not the account email
   SMTP_PASS=<the SMTP key from that same screen>       # not the account password
   SMTP_FROM=noreply@crm.ersah.in                       # unchanged
   ```
   Port 587 is STARTTLS; `secure` is derived from the port (`=== 465`) in
   `emailService.ts`, so neither port needs a code change.

5. Redeploy (or restart the container so it re-reads the env file) and confirm
   at **Admin → Settings → Email health**: the SMTP status line goes green and
   the delivery log (§2c) starts recording `SENT`.

6. Verify placement: send to a `mail-tester.com` address (expect 9–10/10) and
   to a real Gmail account — "Show original" should read `SPF: PASS`,
   `DKIM: PASS` with `d=crm.ersah.in`, and `DMARC: PASS`.

> ⚠️ **The inbound reply bridge is unaffected.** Replies arrive over IMAP on the
> Plesk `reply@crm.ersah.in` mailbox (§3); only *outbound* moves to the relay.
> Brevo forwards the `Reply-To` header unchanged, so `reply+<token>@…` keeps
> routing replies back into Messages. Do not change `INBOUND_*`.

> Keep `p=none` in DMARC until the relay has been live for a week and the `rua`
> reports show Brevo passing alignment; only then consider `p=quarantine`.

### Two channels: don't let digests eat the relay's quota

A relay's free tier meters everything, and Brevo's 300/day is **shared between
campaigns and transactional mail**. This app's own scheduled traffic is not
small — the hourly unread digest (`:20`), daily interaction/stage/retention
reminders and company-need alerts (09:00), the daily activity digest (07:30),
meeting reminders every 15 minutes, the weekly mentor digest and analytics
report, plus an announcement that fans out to *every* user at once. None of it
is urgent, and all of it would compete with the one mail that actually matters:
the verification link someone is waiting on.

So outbound mail is split by `category` (`src/services/emailService.ts`):

| Channel | Env | Carries | Where it should point |
|---------|-----|---------|-----------------------|
| **primary** | `SMTP_*` | `verification`, `invitation`, `password-reset`, `message`, `test`, **and anything uncategorised** | the relay (Brevo) |
| **bulk** | `SMTP_BULK_*` | `unread-digest`, `activity-digest`, `mentor-digest`, `analytics-report`, `meeting-reminder`, `interaction-reminder`, `stage-deadline`, `retention-reminder`, `company-need-alert`, `announcement` | our own Plesk server |

Two deliberate choices:

- **Uncategorised mail stays on the primary channel.** Silently downgrading the
  deliverability of a call site nobody has classified yet is the sort of
  regression that only surfaces when it costs a user. New bulk senders opt in
  by passing a category; nothing opts in by accident.
- **`SMTP_BULK_HOST` unset ⇒ one channel.** Preview and topic environments need
  no extra configuration, and the behaviour is exactly what it was before.

**Use a different From domain for bulk.** `SMTP_BULK_FROM=noreply@ersah.in`
keeps the two reputations independent: a digest someone marks as spam then
cannot drag down the password-reset mail signed by `crm.ersah.in`. The bulk
domain needs its own SPF/DKIM/DMARC — `ersah.in` already has all three plus the
shared PTR, confirmed with `./infra/check-mail-dns.sh ersah.in`.

Both channels' health, and a 24-hour per-channel and per-category count, are on
the **Admin → Settings → Email health** panel — so "are we near the 300/day
cap?" and "which job is spending it?" are answerable without touching the
server. `EmailLog.transport` records which channel carried each message.

## 2c. Did the mail actually go out? (`EmailLog`)

`sendEmail()` records every attempt (#1194): recipient, subject, category,
`SENT` / `FAILED` / `SKIPPED`, and the error. Read it at **Admin → Settings →
Email health** or `GET /api/admin/email-log`.

This exists because the failure mode it covers is invisible otherwise: the
function used to `return` silently when `SMTP_USER` was unset, and most callers
swallow send errors, so a broken pipeline looked exactly like a batch of users
who ignored their messages. Read the statuses as:

- **A wall of `SKIPPED`** — SMTP is not configured on this environment. The mail
  was never attempted.
- **`FAILED` with a 5xx string** — the server rejected it. `550-5.7.26` is the
  authentication problem in §1; other 5xx are usually reputation or content.
- **All `SENT`, and people still do not answer** — delivery is working and the
  problem is placement (spam folder) or genuinely no reply. `SENT` means our
  SMTP server accepted the message, **not** that it reached an inbox.

The body is deliberately not stored — metadata only.

**Retention.** Rows hold a recipient address, so the log is covered by the same
discipline as the rest of the personal data:

- a daily job prunes anything older than `EMAIL_LOG_RETENTION_DAYS` (90) —
  `pruneEmailLog()`, registered on the 09:00 schedule;
- account erasure clears the address explicitly (`src/lib/accountErasure.ts`).
  The log is keyed by address rather than by a relation, so **nothing cascades
  to it** — without that call an erased person's address outlives their account.

Add both whenever a new log-like table starts holding addresses.

## 3. Inbound replies → Messages

The full round trip is in place:

- Outgoing message emails set
  `Reply-To: reply+<relationId>~<recipientUserId>.<sig>@<INBOUND_EMAIL_DOMAIN>`
  (`src/lib/replyToken.ts`). The token is an HMAC, so it can't be forged, and it
  names both the thread and the person the notification was sent to.
- `src/lib/inboundEmail.ts` (`routeInboundEmail`) verifies the token, works out
  who wrote the mail, then stores a `Message` (`channel: EMAIL`) and notifies the
  other party — so it appears under **/messages/<relationId>**.

### How the writer is identified

Two signals, in order:

1. **`From` matches a participant's account email** — the strong signal.
2. **Otherwise, the recipient named in the signed token**, provided that user is a
   participant of the thread. This is the common case in practice: people forward
   work mail to a personal account and reply with *that* identity, so `From` is
   not the address on their profile, and matching only on `From` silently dropped
   those replies.

Honouring the token is not a weakening: it is delivered only to that user's own
registered address, and anyone holding the mail could already take the account
over via a password reset. The residual exposure is a *forwarded* notification —
whoever receives the forward can post as the original recipient. Attribution via
the token (rather than `From`) is logged.

Tokens minted before this carried a bare `relationId`; they still verify and fall
back to signal 1 only.
- Two entry points feed that one routing function:
  - **`POST /api/inbound-email`** accepts `{ to, from, text, messageId? }` (+ an
    `x-inbound-secret` header when `INBOUND_SECRET` is set) — for a provider
    inbound-parse webhook (SendGrid, Mailgun, Postmark) or a manual replay.
  - **The IMAP mail bridge** (`src/services/inboundMailBridge.ts`), started at
    server boot from `src/instrumentation.ts`. It polls the reply mailbox every
    `INBOUND_IMAP_POLL_SECONDS` (default 60), parses each unseen mail with
    `mailparser`, and routes it. This is what runs in production today.

Only the message's `Message-ID` makes delivery idempotent: IMAP is
at-least-once (a crash between storing the reply and setting `\Seen` replays the
mail), so `Message.inboundMessageId` is `@unique` and a replay is a no-op.

### How the production mailbox is wired (Plesk, `s.ersah.in`)

Postfix runs with `recipient_delimiter = +`, so mail to
`reply+<token>@crm.ersah.in` is delivered to the **`reply@crm.ersah.in`**
mailbox, which the bridge drains over IMAPS (`s.ersah.in:993`). `crm.ersah.in`
also has a catch-all to `m@ersah.in`; the dedicated `reply@` mailbox takes
precedence over it, which keeps reply traffic out of a personal inbox.

> ⚠️ The bridge starts **only when `INBOUND_IMAP_HOST`/`USER`/`PASS` are all
> set**, and those live solely in `/etc/internship-crm/prod.env`. Do not add them
> to the preview or topic env: two pollers on one mailbox race over the `\Seen`
> flag. `INBOUND_IMAP_ENABLED=0` disables it without removing the credentials.

Replies only work on **mentorship threads** — conversation/group chats
deliberately ship without a `Reply-To`, since the token is relation-scoped
(`src/app/api/messages/route.ts`).

To test the endpoint directly once a relation exists (token from `replyAddress()`):

```bash
curl -X POST https://crm.ersah.in/api/inbound-email \
  -H 'content-type: application/json' \
  -H "x-inbound-secret: $INBOUND_SECRET" \
  -d '{"to":"reply+<relationId>.<sig>@crm.ersah.in","from":"mentee@example.com","text":"Test reply"}'
```

A `{ ok: true, created: true }` response means the message was threaded; open
`/messages/<relationId>` to see it.

## 4. Scheduled jobs (reminders & digests)

`initCronJobs()` in `src/services/emailService.ts` registers the node-cron
schedules: mentor-interaction + stage-deadline + retention reminders and
company-need alerts (daily 09:00), meeting reminders (every 15 min, firing
45–60 min ahead), the daily activity digest (07:30), the hourly unread-message
digest (:20), and the weekly mentor digest + analytics report (Mondays 08:00 /
08:15).

It is started at boot by `src/instrumentation.ts`, which POSTs
`/api/cron/start` — the same edge-runtime workaround as the mail bridge, and
deferred onto a timer because `register()` resolves before the server accepts
connections. `GET /api/cron` still runs every job once for an authenticated
ADMIN.

> ⚠️ **`CRON_SECRET` belongs in production only.** These jobs email real people,
> and the preview DB is shared with every topic env holding the same addresses —
> a scheduler there would mail real users. `CRON_ENABLED=0` stops it without
> removing the secret.

`prisma/backfill-cron-baseline.mjs` (run by `deploy-prod.sh`) is a **one-shot**
baseline: several jobs are "everything not yet marked" queries — the unread
digest has no lower bound on message age — so without it the first tick mails out
the whole backlog. It records `Setting['cronBaselineAt']` and self-skips
afterwards; do not make it run every deploy, or it will mark newly stale work as
handled and suppress the reminders permanently.

## Relevant env

| Var | Purpose |
|-----|---------|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Outbound SMTP |
| `INBOUND_EMAIL_DOMAIN` | Domain in the generated `reply+…@` address |
| `INBOUND_SECRET` | Shared secret the inbound webhook checks (`x-inbound-secret`) |
| `INBOUND_IMAP_HOST` / `INBOUND_IMAP_PORT` / `INBOUND_IMAP_USER` / `INBOUND_IMAP_PASS` | Reply mailbox the bridge drains (production only) |
| `INBOUND_IMAP_MAILBOX` / `INBOUND_IMAP_POLL_SECONDS` | Folder (default `INBOX`) and poll interval (default 60s, min 30) |
| `INBOUND_IMAP_ENABLED` | Set to `0` to stop the bridge while keeping the credentials |
| `CRON_SECRET` | Registers the scheduled jobs at boot (production only) |
| `CRON_ENABLED` | Set to `0` to stop the schedules while keeping the secret |
