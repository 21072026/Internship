# Safeguarding — contact-detail and keyword detection, and message retention (#2056)

Universities, schools and youth programmes — the SOURCE institutions this
product sells into — ask one question before anything else: *what happens if a
mentor starts asking a 17-year-old for their personal number?* This is the
answer, end to end.

| Piece | Where |
|---|---|
| The rule (pure, client-safe, corpus-tested) | `src/lib/safeguarding.ts`, `scripts/test/safeguarding.test.mjs` |
| The only writer of flags | `src/lib/safeguardingScan.ts` |
| The record | `SafeguardingFlag` (`prisma/schema.prisma`, in `TENANT_MODELS`) |
| The review queue | `/admin/safeguarding`, `GET /api/admin/safeguarding`, `PATCH /api/admin/safeguarding/[id]` |
| Watch list + retention window | `GET/PUT /api/admin/safeguarding/settings` → settings `safeguardingKeywords`, `messageRetentionDays` |
| The retention sweep | the `message` entry in `src/lib/retentionEntries.ts` (#1678's one nightly job) |
| End-to-end test | `e2e/safeguarding.spec.ts` |

## Two decisions that are not up for tuning

1. **Detection never blocks or holds a message.** It flags and notifies; the
   message is delivered whatever the scan finds. A false positive that silently
   swallowed a mentee's message would be worse than the risk it guards against.
   The scan runs after the message row is written and cannot fail the send — an
   error in it is logged and the request carries on.
2. **Messaging stays free for mentors and mentees.** These controls are an
   admin surface. Nothing about them is a gate, a paywall or a quota on the
   participant's channel.

## What is detected

Every message write path calls the scan: the in-app composer (new messages and
**edits** — an edited body is re-scanned, and the same term is never flagged
twice), the mentor's e-mail composed in the app, and replies that arrive by
e-mail through the inbound bridge.

- **Phone numbers** — 9 to 15 digits that *look dialled*: starting with `+`,
  `00` or a trunk `0`, or the US `(555) 123-4567` shape. Spaces, dots, dashes,
  slashes and brackets between the digits are tolerated (`0176 12345678`,
  `+49 (0)176 1234 5678`, `0532 123 45 67`, `030/1234567`, `0 5 3 2 …`).
- **Spelled-out numbers** — seven or more digit words in a row, in English,
  Turkish or German (`five five five one two three four`, `sıfır beş üç iki …`,
  `null eins sieben sechs …`).
- **E-mail addresses** — plain ones, and the obfuscated shapes people use to get
  past a filter: `jane at example dot com`, `jane [at] example [dot] de`,
  `ayse(at)ornek.com.tr`, `max ät beispiel punkt de`. The spelled-out form only
  counts with a real top-level domain at the end, so "meet me at home dot five"
  stays quiet.
- **Watch keywords** — the programme's own list (one word or phrase per line,
  up to 100, edited on `/admin/safeguarding`). Whole words only, ignoring case and
  accents, with Turkish i/ı/İ and German ß folded: `geheim` matches `GEHEIM`,
  `kişisel` matches `KİŞİSEL`, `art` never matches `party`.

## What is deliberately NOT detected

False positives are the real failure mode — a queue full of dates and prices is
a queue nobody reads — so each of these is a choice, pinned by a negative case in
the corpus test:

- **Dates, times and ranges** (`07.10.2026`, `2026-10-07`, `9.30-11.00`).
- **Amounts** — a number next to a currency (`3.500 €`, `45.000 TL`, `$55,000`).
- **Bare digit runs** that do not look dialled — order numbers, application
  numbers (`123456789`, `2026-000123`) — and digits glued to letters (IBANs,
  invoice references like `INV-004912345`).
- **Contact details in mail that arrived by e-mail.** Every e-mail carries a
  signature with a phone number and an address, and the channel itself already
  exchanged addresses; flagging them would bury the queue. Watch keywords *are*
  still checked in those replies.
- **Messages written by admins** — staff giving out the programme office's number
  is the programme working.
- **Social-media handles and messenger names** ("add me on Insta: …"). There is
  no reliable pattern for a handle; a programme that worries about a specific
  app adds its name (`whatsapp`, `telegram`, `snapchat`) to the watch list.
- **Images and attachments.** Only message text is scanned.

## What an admin sees

- A **bell entry** — "A message needs a safeguarding review." — linking to the
  queue, at most once an hour per admin however many messages were flagged in
  that hour. The bell never says who wrote what.
- **`/admin/safeguarding`** — ADMIN only, checked at every route; tenant-scoped by
  a hand-written `orgId` conjunct, so another tenant's flag answers 404. Each row
  shows the kind, the matched term, who sent it and in which pair, and a short
  window of the message around the match, recomputed from the live body. Actions:
  **No action needed**, **Mark reviewed**, **Escalate**, and **Reopen** to undo a
  misclick. Each review is written to the activity log (`safeguarding.reviewed`)
  with who and when — never the message text.

The flag row itself stores only a **masked** contact detail (`01•• ••••••78`) or
the keyword. The message body is the record; a flag that kept the full number
would outlive the body when retention masks it.

## Message retention

`messageRetentionDays` is a per-organisation setting, **0 (keep forever) by
default** — how long a programme keeps private conversations is its own
data-protection decision. When set, the nightly retention job masks every message
whose sender belongs to that org and which is older than the window:

- the **same masking as "delete for everyone"**: attachments removed, body
  emptied, `deletedForEveryoneAt` stamped. The row stays, so the other
  participant's thread keeps its shape ("message deleted" where the text was) and
  counts that read messages keep working;
- a window shorter than **30 days is raised to 30**, so a typo cannot mask
  yesterday's conversation;
- it is **one entry in #1678's retention registry**, not a second schedule; its
  count shows in the nightly `retention.pruned` activity row as `message=0/Nm`.

**Whose org.** `Message` has no `orgId`, and a project or group conversation has
none either, so a message belongs to its **sender's** org — the same org whose
watch list it was scanned against. An org-less account belongs to the default org.

## Erasure

Erasing an account (`src/lib/accountErasure.ts`) masks the person's messages and
deletes the safeguarding flags raised on them: the flag names the person as its
subject and points at text that no longer exists. A case that was escalated
belongs in the institution's own case file before an erasure is carried out.
