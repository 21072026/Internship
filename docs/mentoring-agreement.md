# Mentoring agreement (#1790, story #1788)

The text both sides of a pairing accept at kickoff. It copies the contributor-terms design
(`src/lib/contributorTerms.ts`, `docs/legal/contributor-terms-in-app.md`) per organisation.

- **Data, versioned, never edited.** `MentoringAgreement` holds one row per
  (org, key, version, locale), exactly one locale `isAuthoritative`. Saving always publishes a
  new version (`publishAgreementVersion()`, the server numbers it); there is no update function
  and `PATCH`/`PUT`/`DELETE /api/admin/agreements` answer `405 immutable`.
- **Evidence.** `MentoringAgreementAcceptance` — relation, user, version, side (MENTOR/MENTEE),
  locale shown, hashed IP/UA; written once (`acceptAgreement()`), unique per
  (relation, user, version). A pairing owes the version **in force**: an acceptance of v1 says
  nothing about v2 (`agreementStateForRelation()`), and an acceptance from a stale page is 409.
- **Tenant data.** `MentoringAgreement` carries `orgId` and is in `TENANT_MODELS`; the acceptance
  is reached through its relation and is not.
- **A fresh org is never empty.** `ensureDefaultAgreement()` installs the starter template
  (`src/lib/mentoringAgreementDefault.ts`, EN binding, TR/DE translations) as version 1 the first
  time an org's agreement is read. It is a template and says so in its first line — the operator
  should review and adapt it; editing that file never changes what anyone accepted.
- **Admin.** `/admin/agreements` (nav, `mentorship` capability): edit the text in EN/TR/DE,
  choose the binding language and the effective date, save as a new version; list of versions
  with acceptance counts; active pairings with each side's acceptance of the version in force.

## Kickoff (#1792)

- **A prompt, never a gate.** An unsigned agreement disables nothing — messaging, meetings,
  goals, evaluations, the portal and the pipeline all work; the rule is written at the check
  (`src/lib/mentoringAgreementRule.ts`) and asserted in `e2e/mentoring-agreement-kickoff.spec.ts`.
- **Both sides accept their own side.** `AgreementCard` on `/portal` and `/mentor/mentees/[id]`
  shows the text in the viewer's language (the binding text when no translation exists), an
  unticked box and an accept button; afterwards a one-line "Agreed … · vN · view".
  `POST /api/mentorship/[id]/agreement/accept { version }` — the relation's mentor or mentee only
  (an ADMIN gets 403: an acceptance somebody else clicked is no evidence), the version in force
  only (409 `stale_version`), idempotent.
- **Prompted on creation:** `POST /api/mentorship` sends each side an in-app `agreement.review`.
- **Admin:** an "Agreement" badge and filter (signed / mentor only / mentee only / unsigned) on
  `/admin/mentorship` (`?agreement=` on `GET /api/mentorship`, one SQL predicate on the
  acceptance's recorded side), and `GET /api/admin/agreements/acceptances` for the whole programme.
- **Re-consent:** publishing a new version never invalidates an earlier acceptance; a pairing
  simply owes the version in force, and a person who accepted an older one sees "the agreement
  has been updated".
