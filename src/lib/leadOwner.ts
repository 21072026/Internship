// Who owns a new MARKETING lead (#2580 item 3, #2569).
//
// A funnel record's owner is its `mentorId` (docs/marketing-vertical/
// pipeline-record.md) — a required FK, so a funnel record without an owner
// cannot exist. "No owner" therefore has exactly one representation in this
// product: a lead that has NOT been placed on the funnel yet — a CompanyInquiry
// still waiting in /admin/company-inquiries, which every admin of the org sees
// and which the list labels "unowned". Nothing is ever dropped for want of an
// owner.
//
// The org-level default (`defaultLeadOwnerId`, src/lib/settings.ts) is read
// here and only here, by:
//   • the marketing landing's demo form (/api/company-inquiry): a default owner
//     means the request lands straight on that person's funnel; none means it
//     waits in the unowned list;
//   • the hand-typed lead (/api/admin/marketing-accounts, #2562), when the body
//     names no owner.
//
// A candidate is valid only if it is an ACTIVE ADMIN or MENTOR of THE SAME org —
// the same roles the import accepts for `--owner` (resolveImportOwner). A
// setting that names anybody else — a user who left, was deactivated, became a
// mentee, or belongs to another tenant — reads as "no default owner" rather
// than placing a lead with the wrong person or across a tenant boundary.

import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { runUnscoped } from '@/lib/tenantAmbient';
import type { MarketingImportOwner } from '@/lib/marketingImportStore';

export const LEAD_OWNER_ROLES = ['ADMIN', 'MENTOR'] as const;

/**
 * The user `userId` as a lead owner of `orgId`, or null when that user may not
 * own this org's leads. The org is compared EXPLICITLY (never through the
 * tenant middleware, which is off on every deployment today), so a foreign id
 * is refused whatever the isolation flag says.
 */
export async function findLeadOwner(orgId: string, userId: string): Promise<MarketingImportOwner | null> {
  if (!orgId || !userId) return null;
  const user = await runUnscoped(() =>
    prisma.user.findFirst({
      where: { id: userId, orgId, isActive: true, role: { in: [...LEAD_OWNER_ROLES] } },
      select: { id: true, email: true, orgId: true, role: true },
    }),
  );
  return user;
}

/** The org's default lead owner, or null when none is set or the one set is no longer valid. */
export async function resolveDefaultLeadOwner(orgId: string): Promise<MarketingImportOwner | null> {
  const id = (await getSetting('defaultLeadOwnerId', orgId)).trim();
  if (!id) return null;
  return findLeadOwner(orgId, id);
}
