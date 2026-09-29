// The org of the USER a file row hangs off (#2542).
//
// Document, CvFile and AvatarFile carry no orgId: their tenant is their owner's
// (or, for an owner-less template, its uploader's). Their routes therefore
// resolve that user's orgId and ask `inCallerTenant` (src/lib/tenantFilter.ts),
// the one-row form of `tenantWhere()`.
//
// The lookup runs OUTSIDE the tenant auto-filter on purpose. Under
// MT_ENFORCE_ISOLATION the middleware would hide a foreign user, and "not found"
// cannot be told apart from "never existed" — a deleted uploader must read as
// an unknown org, a foreign one as a different org. Resolving the parent across
// tenants and then comparing is what makes the flag-off and flag-on worlds give
// the same answer; the comparison, not the lookup, is the boundary.
//
// Client-safe by construction (no orgContext import): `documentAccess.ts`,
// which reaches this, is imported by a client component for its constants —
// `runUnscoped` is the seam built for exactly that (src/lib/tenantAmbient.ts).

import { prisma } from '@/lib/prisma';
import { runUnscoped } from '@/lib/tenantAmbient';
import { inCallerTenant } from '@/lib/tenantFilter';

/** Each user's orgId (null when org-less); ids that match no user are absent. */
export async function orgIdsOfUsers(userIds: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await runUnscoped(() =>
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, orgId: true } }),
  );
  return new Map(rows.map((row) => [row.id, row.orgId]));
}

/**
 * May a caller of `callerOrgId` reach rows owned by `userId`? True for the
 * same tenant, by `inCallerTenant`'s rule: an org-less caller, and an org-less
 * or missing user, are the default org's — never a wildcard. Callers answer
 * false with 404, never 403.
 */
export async function userInCallerOrg(userId: string, callerOrgId: string | null | undefined): Promise<boolean> {
  const orgs = await orgIdsOfUsers([userId]);
  return inCallerTenant(orgs.get(userId), callerOrgId);
}
