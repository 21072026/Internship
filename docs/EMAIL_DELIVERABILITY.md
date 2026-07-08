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

The application side is already built:

- Outgoing message emails set `Reply-To: reply+<relationId>.<sig>@<INBOUND_EMAIL_DOMAIN>`
  (`src/lib/replyToken.ts`). The token is an HMAC, so it can't be forged.
- `POST /api/inbound-email` accepts `{ to, from, text }` (+ an `x-inbound-secret`
  header when `INBOUND_SECRET` is set), verifies the token and that the sender is
  a participant, then stores a `Message` (`channel: EMAIL`) and notifies the
  other party — so it appears under **/messages/<relationId>**.

What's still required in **infrastructure** is a **mail bridge** that receives
mail addressed to `reply+*@crm.ersah.in` and POSTs it to `/api/inbound-email`.
Options:

- **Provider inbound parse webhook** (SendGrid Inbound Parse, Mailgun Routes,
  Postmark inbound). Point the MX/subdomain at the provider and set the webhook
  URL to `https://crm.ersah.in/api/inbound-email` with the `x-inbound-secret`
  header. Simplest and most reliable.
- **IMAP poller** — a small scheduled job that reads the `reply+`/catch-all
  mailbox over IMAP and POSTs each new message to the endpoint. Fits the existing
  `node-cron` jobs in `src/services/emailService.ts`; needs IMAP credentials.

To test the endpoint directly once a relation exists (token from `replyAddress()`):

```bash
curl -X POST https://crm.ersah.in/api/inbound-email \
  -H 'content-type: application/json' \
  -H "x-inbound-secret: $INBOUND_SECRET" \
  -d '{"to":"reply+<relationId>.<sig>@crm.ersah.in","from":"mentee@example.com","text":"Test reply"}'
```

A `{ ok: true, created: true }` response means the message was threaded; open
`/messages/<relationId>` to see it.

## Relevant env

| Var | Purpose |
|-----|---------|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Outbound SMTP |
| `INBOUND_EMAIL_DOMAIN` | Domain in the generated `reply+…@` address |
| `INBOUND_SECRET` | Shared secret the inbound webhook checks (`x-inbound-secret`) |
