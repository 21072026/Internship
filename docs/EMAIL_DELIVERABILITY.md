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

## 3. Inbound replies → Messages

The full round trip is in place:

- Outgoing message emails set `Reply-To: reply+<relationId>.<sig>@<INBOUND_EMAIL_DOMAIN>`
  (`src/lib/replyToken.ts`). The token is an HMAC, so it can't be forged.
- `src/lib/inboundEmail.ts` (`routeInboundEmail`) verifies the token and that the
  sender is a participant, then stores a `Message` (`channel: EMAIL`) and notifies
  the other party — so it appears under **/messages/<relationId>**.
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
