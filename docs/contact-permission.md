# Contact permission: may we write to this account, and can we prove it? (#2577)

Story #2575, UWG § 7 / DSGVO. Germany forbids unsolicited advertising e-mail in B2B
too (UWG § 7 Abs. 2 Nr. 2), and the sanction arrives as an *Abmahnung*. So every
account carries, per channel, the basis on which we may contact it **and the proof** —
and the CRM never suggests, and never performs, an advertising contact it cannot prove.

> Not legal advice. The channel rules themselves (which basis opens which channel,
> the limits of § 7 Abs. 3, sender identity and Impressum) are the Fachanwalt-ready
> document of #2576 (`docs/marketing-vertical/outreach-compliance.md`, not yet
> written). This file is the CRM side, and it uses exactly the same four basis codes.

## The model

`ContactPermission` — one row per **account × channel** (`@@unique([companyId, channel])`),
in `TENANT_MODELS`. Company-level on purpose: the person we write to is the account's
contact (`Company.contactEmail`), who is not a `User` — the stand-in lead `User` of a
marketing funnel record has a synthetic address nobody reads. A `ConsentType` on that
User would have been consent attached to the wrong identity.

| Column | Meaning |
| --- | --- |
| `channel` | `EMAIL` / `PHONE` / `POST` |
| `basis` | `DOI_CONFIRMED` · `EXISTING_CUSTOMER_7_3` · `INQUIRY_REPLY` · `NONE` |
| `source` | who wrote the current basis: `DOI_LINK`, `INQUIRY`, `ADMIN`, `IMPORT`, `INGEST` |
| `address` | the address the basis was established for (lower-cased) |
| `textVersion`, `textLocale` | the opt-in wording version and language that was ticked |
| `requestedAt`, `confirmedAt` | when the box was ticked; when the link was confirmed |
| `inquiryId` | the enquiry the evidence came from (no FK — enquiries have their own retention) |
| `grantedById`, `reason` | a manual record: who, and why (the sale behind a § 7(3) record) |
| `revokedAt`, `revokedVia` | withdrawal — `LINK` (the person) or `ADMIN` |

**Revocation keeps the basis.** A revoked row still says what was revoked; only a NULL
`revokedAt` makes it effective. The ActivityLog (`contact_permission.*`) keeps the
history of every change.

**No IP address** anywhere on these paths — not on the row, not in the ActivityLog of a
public click. The demo form's privacy section promises the form stores none, and the
proof of a double opt-in here is the signed link (only ever delivered to that address)
plus the two timestamps and the wording version. Data minimisation over a field whose
evidential value for a B2B address is low.

## The rule — one file

`src/lib/contactPermissionRule.ts`, dependency-free, unit-tested in
`scripts/test/contact-permission.test.mjs`. The only writer is
`src/lib/contactPermission.ts`; the test also scans `src/` and fails if any other file
writes the table.

| Writer | May write |
| --- | --- |
| `import`, `ingest`, `salevali-newsletter` (the machines) | **`NONE` only**, and only when no row exists |
| `doi` (the address owner's click) | `DOI_CONFIRMED`, with `confirmedAt` |
| `inquiry` (an enquiry becoming an account) | `INQUIRY_REPLY`, or `DOI_CONFIRMED` if the enquiry was already confirmed |
| `admin` | `EXISTING_CUSTOMER_7_3` (e-mail only, with a reason ≥ 10 chars), `INQUIRY_REPLY`, `NONE` |

A write outside its writer's list **throws** (`ContactPermissionRuleError`) — a machine
path trying to write a basis is a bug, and coercing it silently to `NONE` would hide it.

Replacement (`writeReplaces`):

- a machine write never replaces anything — an import re-run must not erase a
  confirmation, and must not un-revoke a withdrawal;
- a DOI click replaces anything, including an earlier withdrawal (the person opted back in);
- a conversion only upgrades a weaker, live basis — never downgrades a DOI or § 7(3)
  record to `INQUIRY_REPLY`, never revives a revoked row;
- an admin replaces, **except** an advertising basis over the person's own withdrawal
  (`revokedVia = 'LINK'` → `owner_objected`). § 7(3) itself ends at an objection, and
  "re-granting" what somebody withdrew is exactly the contact the rule prevents.

**Why the SaleVali newsletter flag is not a basis.** SaleVali's registration box is
pre-ticked (`salevali-client/src/app/pages/auth/Registration.jsx:46`; the Google sign-up
path defaults `newsletter = true` server-side), and a pre-ticked box is no consent
(CJEU C-673/17 *Planet49*). A flag carried over from another product proves nothing
about this address owner's will. Hence `salevali-newsletter` is a machine writer:
`NONE` only. Today no feed reads that flag; the writer name exists so the first one
that does is refused by the rule instead of by review.

**Why an admin cannot type in a DOI.** A double opt-in is the address owner's own
click. Nobody can perform it on their behalf.

## Double opt-in (the demo form)

The marketing demo form (#2569) has a separate, unchecked product-news box, stored on
the enquiry as `marketingOptInRequested` + `marketingOptInTextVersion`.

1. **Ticked → one confirmation mail** (`src/lib/contactPermissionDoi.ts`,
   `sendDoiConfirmation`), from the request route after the row is written. It carries
   a "yes" link and a "do not e-mail me" link, on the host the form was sent from
   (`requestOrigin()` — a served host only), and advertises nothing: an advertising
   sentence in a confirmation mail is itself unsolicited advertising (BGH I ZR 164/09).
   Category `consent` (essential): the recipient is not a User.
2. **Cap: one mail per address per UTC day**, whichever tenant's form asked
   (#2569 § 9). `ContactConfirmationMailCap` holds `HMAC-SHA256(address):day` as its
   primary key, so two concurrent submits cannot both pass, and the table holds no
   address. Keys older than two days are swept on the next insert. The form's own
   `company-inquiry` bucket (3/hour per IP) sits in front. A capped request stays an
   unconfirmed request (`marketingOptInMailSentAt` NULL); nothing is lost that the
   person cannot redo tomorrow.
3. **The click.** Both links point at a page (`/contact-permission/confirm`,
   `/contact-permission/opt-out`) whose button POSTs to
   `/api/contact-permission/{confirm,opt-out}` — mail scanners prefetch every URL, and a
   mutating GET would confirm consents nobody gave. The token is an HMAC over the enquiry
   id with a purpose prefix (`src/lib/contactPermissionTokens.ts`, the
   `newsletterTokens.ts` pattern), so a confirm token is not an opt-out token. Confirm
   works for 30 days after the request (`DOI_CONFIRM_WINDOW_DAYS`, decided from the
   enquiry's `createdAt`); opt-out never expires.
4. **Where the proof lands.** Confirming sets `marketingOptInConfirmedAt`. If the
   enquiry is already an account (the default owner placed it), the account's EMAIL row
   becomes `DOI_CONFIRMED` at once; otherwise the conversion carries it over
   (`applyInquiryPermission`, called from `src/lib/inquiryLead.ts`). Opting out sets
   `marketingOptOutAt` and revokes the account's EMAIL row (`revokedVia = 'LINK'`),
   creating a revoked `NONE` row if there was none, so a later conversion cannot write a
   basis over it.

## Sessionless writers pass `orgId`

The DOI and opt-out clicks, a web request placed on the default owner's funnel and the
import have no session. `ContactPermission` is registered in `TENANT_MODELS`, and the
middleware fills `orgId` only from a **bound** context — so every create in
`contactPermission.ts` passes `orgId` itself (the enquiry's org, the import owner's org,
the company's org), and every lookup filters on it. A row whose `orgId` differs from the
writer's is never overwritten.

## The gate

`canSendMarketingEmail({ orgId, companyId, address })` in `src/lib/contactPermission.ts`
(the rule: `marketingEmailAllowed`) — true only for a live `DOI_CONFIRMED` (with
`confirmedAt`) or `EXISTING_CUSTOMER_7_3` EMAIL row **for that address**. A confirmation
is for the address that confirmed, not for whoever the contact is today.

**There is no advertising-mail path to account contacts in the app today.** The
newsletter (#1469) and announcements go to signed-in `User`s under their own opt-out
groups; the enquiry notification goes to the tenant's own admins; the DOI mail is
transactional. The first path that mails an account contact for advertising must call
the gate per recipient and skip on `false` — that is what this section is for.

## Surfaces

- **Account page** (`/admin/companies/[id]`, `/sales/accounts/[id]`): a "Contact
  permission" card, per channel, with basis, address, times, wording version, source
  (the § 7(3) reason only for ADMIN); under the contact e-mail, a green "advertising
  e-mail permitted" or an amber warning. ADMIN gets the editor
  (`PUT /api/admin/companies/[id]/contact-permission`).
- **Lists**: `/admin/companies` has a "Provable e-mail permission" filter
  (`GET /api/companies?permission=email`) and a badge; `/sales/accounts?permission=email`
  the same for a rep's own accounts. The list filter checks the row, not that its
  address still equals `contactEmail` (Prisma cannot compare two columns); the badge and
  the send gate do compare, so a changed contact reads as "not permitted" everywhere it
  matters.
- **Deleting an account** (#2441/#2559) deletes its permission rows (`onDelete: Cascade`,
  listed in the delete dialog). The withdrawal stays provable on the enquiry row
  (`marketingOptOutAt`) for as long as enquiries are retained; nothing else is kept.
