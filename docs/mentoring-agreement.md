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
- **Not here:** the kickoff acceptance screen and the "who has not accepted" follow-up (#1792).
