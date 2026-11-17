# Product-update interest signup (#1406)

The collapsed control below the landing page's final primary CTA is independent
of registration, mentor applications, company enquiries and career newsletters.
It creates no account. `/api/subscribe` uses the company-enquiry public-host
resolution and anti-spam pattern: empty honeypot, at least three seconds from
render, three submissions per IP/hour, explicit boolean consent validated by the
server. Email is trimmed/lowercased and unique per organisation. Duplicate
submissions return the same receipt without changing evidence or resending mail.

## Consent and delivery

A new request records server time, notice version, role and locale. One consent
email links to the confirmation page; a human presses Confirm, which POSTs the
signed credential. GET never confirms. Confirmation expires after seven days and
is consumed atomically; withdrawal cannot be reversed by replay or signup.
Tokens use purpose-separated HMAC-SHA256 over a random UUID, the existing server
secret, constant-time verification and stored SHA-256 hashes. They are never
included in admin exports or logs. Unsubscribe credentials have no expiry.

`sendSubscriberMail` is the entry point for any future product update. It reuses
`sendEmail`, delivery suppression, outbound approval and the sealed mail queue.
The notification-router baseline documents exactly two direct transport calls,
following the existing newsletter/applicant exception: a Subscriber has no User
recipient for that ledger. All transport/suppression checks still apply.
There is no new campaign scheduler or parallel newsletter preference system.
`subscriberId` travels in the sealed envelope. Preparation, queue drain and the
final transport boundary check the persisted consent, confirmation, expiry and
withdrawal. A missing/expired row denies delivery. Existing user preferences,
bounce/complaint suppression and customer-mail locks remain additional vetoes.
No unconfirmed request authorizes an announcement or re-engagement message.

Every list message, including the confirmation, has a visible unsubscribe link
and raw `List-Unsubscribe` / `List-Unsubscribe-Post` headers. RFC 8058 clients POST
to `/api/subscribe/unsubscribe?t=…` without cookies. GET is inert and redirects to
a no-referrer/no-index page whose browser performs the POST. Confirmation and
withdrawal always return a generic receipt, including for unknown credentials.

## Attribution and access

Current main already contains `inquiryAttribution.ts` (#2569). The form reuses
`utmFromSearch` and `readInquiryAttribution` for this submission only. Referrer
queries/fragments are discarded. This does not implement #1390's first-touch
tracking, introduce cookies, or add another attribution system.

Organisation admins reach `/admin/subscribers` from Company enquiries. Page and
API both require server-side permission and organisation-admin tier; programme
admins cannot read it. JSON/CSV resolve the session organisation and filter its required orgId explicitly. The latest 1,000
rows show role, locale, confirmation/withdrawal state, source and campaign.
CSV uses the existing formula-escaping cell encoder and includes no credentials.

## Retention and erasure

The existing retention registry deletes unconfirmed requests after seven days
and all confirmed records (including withdrawals) after 365 days from signup.
Delivery also denies expired records without waiting for the retention tick.
An account erasure deletes matching subscriber rows within that account's tenant.
For a contact without an account, the operator can fulfil an earlier erasure
request by deleting that tenant/address's Subscriber record; absent rows cannot
authorize queued mail. No production data access is needed by contributors.

Privacy copy in EN/TR/DE records this processing and retention, with a dated
notice version on each request. This list is consent-only; neither CSV export nor
an existing account constitutes permission to import/send to arbitrary addresses.
