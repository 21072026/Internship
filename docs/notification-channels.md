# Who gets what, where and when (#1714)

The notification router (`src/lib/notifications/router.ts`) asks three questions
per recipient and channel, in this order. The rules are pure in
`src/lib/notificationChannelPrefs.ts` (unit spec:
`e2e/notification-channel-prefs.unit.spec.ts`); the router enforcement is pinned
in `e2e/notification-router.spec.ts`.

## 0. Is this person in the event's audience? (#1944)

A catalogue entry (`src/lib/notifications/catalog.ts`) may name its `audience`,
the roles the event is written for. A recipient whose role is not listed is
recorded `SKIPPED` / `audience` on every channel and told nothing, whatever the
call site passed. The rule lives with the event, once, so a card that carries a
candidate's name or an internal decision cannot reach the wrong kind of account
through a call-site slip. An entry without `audience` is unrestricted (every
event older than the field). `audienceAllows()` is the pure check;
`scripts/test/notification-catalog.test.mjs` pins that every hiring event
declares one and that none of the internal ones admits a MENTEE, and
`e2e/hiring-notifications.spec.ts` asserts the router's skip.

The hiring loop, as declared there:

| Event | Audience | Who the call site tells |
|---|---|---|
| `interview_request.received` | MENTOR, ADMIN | the mentee's active mentor (chat card with Approve/Decline) |
| `interview_request.approved` | MENTEE, COMPANY | the candidate and every active user of the requesting company |
| `interview_request.declined` | COMPANY | the requesting company only; the reason code never reaches the candidate |
| `interview_panel.outcome.*` | COMPANY | the company: the decision only, never a score |
| `offer_sent.new` / `offer_sent.mentor` | MENTEE / MENTOR | the candidate (with the offer mail) / their active mentor |
| `offer_<outcome>.admin` | ADMIN | the admin who made the offer (with the decision mail) |
| `offer_<outcome>.company` | COMPANY | the offering company's seats that may see the candidate: an INTERVIEWER only when it sits on a panel about them (`companyUsersWhoMaySee()`, `seatMaySeeCandidate()`) |

The offer mails are rendered by `renderOfferSentEmail()` /
`renderOfferDecisionEmail()` and handed to the router as `email`, so they are
sent unchanged once the router says yes. Because no hiring site pins its
channels any more, chat joins every one of them for a person with a confirmed
chat identity. The company-facing cards link with the `requisition` link kind:
`/company/requisitions/<id>` for the company, `/admin/requisitions/<id>` for an
admin.

## 1. Is the event essential?

An event in the `account_security` e-mail group goes out on every channel it
lists, now. No category switch, channel matrix, quiet window or blackout day
applies — that rule predates this work and is not configurable.

## 2. Does the person want it on this channel?

Stored in `User.notificationPrefs` (JSON, no migration):

```json
{ "deadlines": true,
  "channels": { "deadlines": { "email": false, "push": true } },
  "quietHours": { "start": "21:00", "end": "08:00", "tz": "Europe/Berlin" } }
```

- The **category switch** (`"deadlines": false`) silences every channel — unchanged.
- `channels` is **sparse**: an absent category or channel follows the catalogue's
  `defaultChannels`. So every account that never opened the matrix behaves as before.
- A channel set to `false` is still *attempted* and recorded in the ledger as
  `SKIPPED channel_off`, so "why did I not get that mail?" has an answer.
- Only **push** can be *added* (`true`). E-mail is only ever taken away; a
  category with no bell row does not grow one. The API refuses the other additions
  (`400 channel_not_settable`).
- The e-mail groups (`emailGroups.ts`, the footer link) still apply on top.

## 3. Is now a good time?

E-mail, push and chat (the channels that interrupt) raised while the person's
**quiet window** is open, or on an **org blackout day**, are **held, never
dropped**: the ledger row is claimed and left `QUEUED`, and a
`notification.deferred` job (key `notify-deferred:<dedupeKey>`) runs at the next
open minute. The job reads the preferences **again** — a channel switched off
overnight is skipped then. The in-app bell is never held.

- Quiet hours are read in `quietHours.tz`, else the account's `User.timezone`,
  else UTC. A window across midnight (21:00 → 08:00) works as expected.
- Blackout days are org settings: `notificationBlackoutDates` (`YYYY-MM-DD`,
  comma separated, read in each recipient's zone) and
  `notificationBlackoutWeekends`. A failed settings read holds nothing.
- Nothing is held longer than 16 days: a calendar that is never open releases.

## Where people set it

- `/account` → Notifications → *Where to reach you*: `src/components/NotificationChannelMatrix.tsx`
  (optimistic, rolled back on failure). A disabled box is a channel the category never
  uses; push is offered only for categories that raise router notifications.
- `/admin/settings`: the blackout dates (validated as real calendar dates by
  `PUT /api/admin/settings`) and the weekends switch.
- The one-click `/u/<token>` page is deliberately e-mail-groups only: a mail footer link
  is about mail, and the matrix needs a signed-in account.

## API

`GET /api/account/notification-channels` returns, per category and matrix
channel, the catalogue default, the stored override (`null` = default) and
whether it is settable, plus the quiet hours. `PUT` takes
`{ channels?: { <category>: { inApp?|email?|push?: boolean | null } }, quietHours?: {…} | null }`,
**merges** into the JSON (never touching the category booleans) and is refused
inside an impersonation session. `PUT /api/profile` — which replaces the column —
carries `channels` and `quietHours` over from the stored row and ignores them in
the body.
