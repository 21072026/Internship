# E-mail newsletter (#1469)

A scheduled career-content channel for mentees (and, where the content earns it,
mentors) — separate from announcements, with its own audience, its own schedule,
its own archive and its own unsubscribe.

## Why it is not an announcement

Both broadcast a body to many people, and that is where the similarity ends.

| | Announcement | Newsletter |
|---|---|---|
| Purpose | operational, time-bound | content, stays useful |
| Audience | every active user | `MENTEE` / `MENTOR` / `BOTH` |
| Reader feed | hides anything older than the account (#1161) | full archive, deliberately |
| Editing after the fact | allowed — it fixes what people are about to read (#1162) | refused once `SENT` |
| Opt-out | `announcements` category | its own `newsletter` category + one-click link |
| Delivery record | one `emailedCount` | one `NewsletterSend` row per recipient |

The last two rows are the reason it cannot share `Announcement`'s table: an
issue read eight months later still needs a working unsubscribe, and "who has
already been sent issue X?" has to stay answerable after `EmailLog`'s 90-day
pruning.

## The shape of an issue

An issue is a **form**, not a rich-text box (`src/lib/newsletter.ts`):

```
subject          ≤ 200   the only line most people read
preheader        ≤ 160   shown next to the subject in the inbox
intro            ≤ 600   one or two sentences
tips[1..5]               emoji + heading (≤120) + one or two sentences (≤400)
action           ≤ 300   "ten minutes, tonight"
cta                      label (≤60) + http(s) URL — both halves or neither
mentorNote       ≤ 600   shown ONLY to mentors, on a MENTOR/BOTH issue
```

Those caps are the product, not a storage limit — `Newsletter.content` is JSON
and could hold far more. A newsletter that can become an essay becomes one, and
an essay is the thing people unsubscribe from.

`mentorNote` is what lets one issue serve both audiences: the mentee reads *how
to write a CV bullet*, the mentor reads the same issue plus *ask your mentee to
rewrite two bullets before your next call*.

## Content library

`src/lib/newsletterContent.ts` ships ten ready-to-send issues in **EN/TR/DE**
(CV, interviews, LinkedIn, portfolio, follow-up, first week of an internship,
cold outreach). A module with an empty composer never sends anything, so the
library ships filled: pick an issue, adjust a line, schedule it.

**Adding one** — follow the house style enforced by the existing entries:

1. One idea per issue. "CV tips" is not an idea; "your CV gets six seconds" is.
2. Three or four tips. If a tip needs a paragraph, it is its own issue.
3. Concrete over motivational.
4. An `action` that fits in ten minutes tonight.
5. `mentorNote` only where a mentor has a genuinely different job to do — that
   is what makes an issue `BOTH` rather than two issues.
6. All three languages, or the picker's promise is broken.

Editing a library entry never rewrites an issue already created from it:
`POST /api/admin/newsletters` copies the content into the row, and
`templateKey` is provenance only.

## Sending

`src/lib/newsletterDispatch.ts`. One `NewsletterSend` row per recipient, unique
per `(newsletterId, email)`. That single constraint buys three things:

- a dispatch run that dies half-way can just be re-run — everyone already
  mailed is skipped;
- the sent history outlives `EmailLog` pruning;
- a cron tick and an admin pressing **Send now** cannot double-mail.

An opted-out recipient is **counted in `skippedCount` with no row written** —
storing the address of someone who asked not to be mailed, in order to record
not mailing them, is the wrong trade.

Mail rides the **bulk** SMTP channel (`newsletter` is in `BULK_CATEGORIES`), so a
spam complaint about career tips can never drag the password-reset mail's
reputation down with it. Every message carries `List-Unsubscribe` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`, which is what makes Gmail
and Outlook render their own native unsubscribe control.

### Schedules

Registered by `initNewsletterCron()`, called from `POST /api/cron/start`
alongside `initCronJobs()` — deliberately *not* from inside `initCronJobs`, so
`newsletterDispatch` imports `emailService` and never the reverse.

| Cron | Job |
|------|-----|
| `*/15 * * * *` | dispatch every `SCHEDULED` issue whose time has come, and resume anything stuck in `SENDING` |
| `0 6 * * *` | the cadence: queue the next unused library issue when enough time has passed |

The cadence **schedules, never sends** — for `newsletterSendHour` (default 09:00)
the same day, so a human always has the morning to read, edit or cancel what is
about to go out. Settings live in `SETTING_DEFAULTS` and are edited on
`/admin/newsletters`:

- `newsletterSchedule` — `off` (default) / `weekly` / `biweekly` / `monthly`
- `newsletterAudience` — who an auto-queued issue targets
- `newsletterSendHour` — `0`–`23`

Off by default on purpose: the library ships in the repo, but which day a real
audience gets mail is a decision for whoever owns that audience.

Both jobs are also runnable on demand by an admin:
`GET /api/cron?job=newsletters` and `GET /api/cron?job=newsletter-queue`.

## Unsubscribing

`notificationPrefs.newsletter` — its own category, so switching it off never
silences a message, a meeting reminder or a stage update. Two ways in, one
switch:

- **From the e-mail**: `/newsletter/unsubscribe?token=…`, no session. The token
  is an HMAC over the user id (`src/lib/newsletterTokens.ts`), the same
  construction as the re-engagement leave link, with **no expiry** — an issue
  read eight months later must still have a working unsubscribe. The page POSTs;
  the link itself is a GET, because link scanners prefetch every URL in a
  message and a mutating GET would unsubscribe people who never clicked.
- **From the archive**: `PUT /api/newsletter/subscription`, session-authenticated,
  for turning it back on.

Both merge the single key rather than replacing `notificationPrefs`
(`withNewsletterPref`) — that column holds ten other switches.

## Surfaces

| Path | Who |
|------|-----|
| `/admin/newsletters` | admin — library, composer, live preview, cadence, the record |
| `/newsletters` | any signed-in reader — the archive, audience-filtered |
| `/newsletter/unsubscribe` | public, token |

The composer's **preview** is rendered by `POST /api/admin/newsletters/preview`
through the same `renderNewsletterHtml` the dispatcher uses, and **Send me a
test** goes only to the requesting admin's own registered address. A preview
built by a second code path is a preview of nothing; a test send to a typed
address is an open relay.

The e-mail body is hand-written table HTML with inline styles
(`src/lib/newsletterEmail.ts`) — Outlook renders with Word's engine and Gmail
strips `<style>`. The **archive renders the fields natively** instead of
embedding that HTML, which would fight both the app layout and dark mode.

## Privacy

`NewsletterSend.email` is PII. It cascades on a hard delete, but
`anonymizeUser` keeps the user row — so `forgetEmailLog()` in
`src/lib/accountErasure.ts` clears newsletter sends by address *and* id, exactly
as it does for `EmailLog` (#1211).

## Tests

`e2e/newsletter.spec.ts` (not `@smoke` — the PR gate stays small): a library
issue sends and records every recipient, a sent issue refuses deletion, an
unsubscribed reader is skipped by the next issue, and the public unsubscribe page
refuses a forged token.

No k6 scenario: every newsletter surface is authenticated, and `k6/` is
GET-only and never authenticated (see `docs/testing.md`).
