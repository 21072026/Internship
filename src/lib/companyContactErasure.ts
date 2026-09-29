/**
 * Erase the person, keep the company: the rule (#2434).
 *
 * A merchant's account is the organisation's commercial history — its needs,
 * offers, requisitions, interactions and the enquiry it arrived through. The
 * NAMED HUMAN on those rows is not. `CompanyInquiry.contactName/email/phone`
 * and the three `Company.contact*` columns (#2407) are one person's identity and
 * direct line, and until this rule existed neither erasure path in
 * `src/lib/accountErasure.ts` mentioned them: an erased account read "Erased
 * candidate" while the same person's name, address and telephone number sat
 * untouched on the enquiry next to it.
 *
 * The link is the ADDRESS, not a foreign key — there is no `Contact` model in
 * this repo and neither table references `User`. That makes the second half of
 * this module necessary.
 *
 * ── WHICH TENANT'S ROWS (the part the first draft of this fix got wrong) ────
 *
 * An address is not a tenant boundary. Two tenants may each hold the same
 * merchant (which is why `Company.contactEmail` deliberately has no unique
 * constraint), and every tenant is its own data controller: erasing a person at
 * tenant A's request must not rewrite tenant B's lead that happens to carry the
 * same address. `MT_ENFORCE_ISOLATION` is off in production (#2542), so the
 * Prisma middleware adds no org filter to these writes — the filter built here
 * is the only one there is.
 *
 *   1. The tenant is the ERASED PERSON'S org, read from their own `User` row —
 *      not from the session. Two of the three callers have no session of the
 *      subject: an admin erasing somebody else, and the orphan-applicant
 *      retention sweep, which has no session at all. (With isolation on, the
 *      admin route's own target lookup is already narrowed to the admin's org,
 *      so the two cannot disagree.)
 *   2. A subject with no org is the default org's — the org registration stamps
 *      (#1272, `src/lib/defaultOrg.ts`) and the deploy backfill assigns
 *      (`prisma/backfill-organization.mjs`).
 *   3. A row with no org (`orgId` NULL) counts as the default org's for the same
 *      reason: the next deploy's backfill makes it one. It is therefore in scope
 *      for a default-org subject and for NOBODY else. Without this, a company an
 *      admin typed in since the last deploy (`POST /api/companies` stamps no org
 *      while isolation is off) would keep the erased person's direct line.
 *   4. Never unscoped. `orgScoped(where, null)` returns the `where` unchanged,
 *      which is the right default for a list and the wrong one for a bulk
 *      rewrite of somebody's identity — so rules 1–2 always yield a concrete org
 *      and a missing default org throws instead of widening the write.
 *
 * ── WHAT EACH COLUMN GETS ────────────────────────────────────────────────────
 *
 * The module-wide split in `accountErasure.ts` (#2052), applied:
 *   WROTE  → `CompanyInquiry.message` is the person's own words, so it is
 *            tombstoned (nulled), exactly like `MentorshipRequest.message`.
 *   ABOUT  → `contactName`/`email`/`phone` identify them and `note` is what an
 *            admin wrote about them: scrubbed while the row lives on.
 * `companyName`, `openRoles`, `status`, `locale`, the consent/handled stamps,
 * the conversion link and every date stay — they are facts about the ACCOUNT
 * ("who they hire for, what became of the enquiry"), which is exactly the
 * history this must not destroy. The `Company` row is never deleted and loses
 * only its three contact columns: clearing the address alone would leave the
 * person's name and direct line on the record, which erases nothing.
 *
 * Required columns cannot be nulled, so they take the `User` row's existing
 * tombstone vocabulary (`Erased …`, `erased-<id>@erased.local`) rather than a
 * second one. Re-running is harmless: a second pass reads the already
 * tombstoned address and matches only the rows it wrote itself.
 *
 * Dependency-free apart from two dependency-free siblings, so the whole rule is
 * unit-tested without a database: scripts/test/company-contact-erasure.test.mjs.
 * The Prisma-aware half is `companyContactOps()` in src/lib/accountErasure.ts.
 */
import { ERASED_EMAIL_DOMAIN } from './menteeAccount';
import { orgScoped } from './orgScope';

/** What a required contact-name column says once the person is gone. */
export const ERASED_CONTACT_NAME = 'Erased contact';

/**
 * The address an erased account is rewritten to — on the `User` row by
 * `anonymizeUser`, and on the required `CompanyInquiry.email` column by both
 * erasure paths. One function so the two can never drift apart.
 */
export function erasedAddress(userId: string): string {
  return `erased-${userId}@${ERASED_EMAIL_DOMAIN}`;
}

/** Rules 1 and 2: the concrete org an erasure of this person is confined to. */
export function erasureOrgId(subjectOrgId: string | null | undefined, defaultOrgId: string): string {
  // Rule 4: a blank default would make rule 2 produce "no org", and every
  // caller below would then write across every tenant. Refuse instead.
  if (!defaultOrgId) throw new Error('erasure needs a default organization to resolve an org-less subject');
  return subjectOrgId || defaultOrgId;
}

/** The shape rule 3 produces for a default-org subject. */
export type DefaultOrgErasureWhere<W> = { AND: [W, { OR: [{ orgId: string }, { orgId: null }] }] };

/**
 * Narrow an address-matched `where` to the erased person's tenant.
 *
 *   erasureScoped({ email }, user.orgId, await defaultOrgId())
 *
 * Any other org → `orgScoped(where, orgId)`, the same helper every hand-written
 * tenant filter uses. The default org → that org OR a not-yet-stamped row
 * (rule 3), wrapped in `AND` so the caller's own `where` is never merged into
 * or overwritten by the tenant half.
 */
export function erasureScoped<W extends Record<string, unknown>>(
  where: W,
  subjectOrgId: string | null | undefined,
  defaultOrgId: string,
): (W & { orgId?: string }) | DefaultOrgErasureWhere<W> {
  const orgId = erasureOrgId(subjectOrgId, defaultOrgId);
  if (orgId !== defaultOrgId) return orgScoped(where, orgId);
  return { AND: [where, { OR: [{ orgId }, { orgId: null }] }] };
}

/**
 * What an enquiry carrying the person's address is rewritten to. Every key here
 * is a personal field; anything not listed (company name, roles, status, the
 * conversion link, dates) is the account's and stays.
 */
export function inquiryErasureData(userId: string) {
  return {
    // ABOUT them → scrubbed. `contactName` and `email` are required columns.
    contactName: ERASED_CONTACT_NAME,
    email: erasedAddress(userId),
    phone: null,
    note: null,
    // WROTE by them → tombstoned.
    message: null,
  };
}

/** What a company whose primary contact is the person is rewritten to. */
export function companyContactErasureData() {
  return { contactEmail: null, contactName: null, contactPhone: null };
}
