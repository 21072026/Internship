# Document review chain (#1859)

A document requirement can ask for more than "a file is attached". The rules are
pure in `src/lib/documentReview.ts`; the one writer of decisions and of
`Document.reviewStatus` after upload is `src/lib/documentReviewStore.ts`.

| `approvalMode` | A requirement is satisfied when … |
|---|---|
| `NONE` (default) | any document is attached — exactly the rule before #1859 |
| `SINGLE` | the first configured step approved it (an ADMIN when none is set) |
| `CHAIN` | every configured step approved it, in order |

In every mode a document past `validUntil` satisfies nothing. `validityDays`
stamps `validUntil` on approval (on upload, under `NONE`).

## Steps and who decides them

`reviewerRoles` is an ordered list of `{ step, role, label? }`. Uploading a document
for a `SINGLE`/`CHAIN` requirement creates one `DocumentReview` row per step.
Only the lowest undecided step can be decided (`out_of_order` otherwise).

- `ADMIN`: an admin of the org.
- `MENTOR`: the owner's ACTIVE mentor.
- `COMPANY`: a user of the company the owner is actively placed with. This reader
  may also download the document while the step is current.
- `EXTERNAL`: an admin or the owner's mentor sends the link
  (`POST /api/documents/[id]/review/invite`). The person at that address decides
  at `/document-review/[token]` with no account. The token is cleared when the
  step is decided.

Nobody decides a step on their own document. A rejection needs a reason, which is
the text the owner is told.

## Expiry and the backfill

The cron calls `expireDocuments()` before the missing-document reminder. It runs
one guarded `updateMany` per document, `APPROVED` → `EXPIRED`, and notifies the
owner and the org's admins. Rows older than the column read `PENDING`, so the
deploy runs `prisma/backfill-document-reviews.mjs`. It marks `APPROVED` every
`PENDING` document that has no review step. A second run reports `updated=0`.

Changing a requirement's mode never rewrites documents.
