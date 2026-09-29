// The origin an e-mail link for a member of `orgId` must point at (#2495) —
// the database half of `appLinkOrigin()` in src/lib/servedHosts.ts, which holds
// the rule and its reasoning.
//
// `Organization` is not a tenant model, so this lookup is never rewritten by the
// middleware. A failed lookup is not an error for the mail: it falls back to the
// origin every link used before, which is what a missing mapping means too.

import { prisma } from '@/lib/prisma';
import { appLinkOrigin } from '@/lib/servedHosts';

export async function appOriginForOrg(orgId: string | null | undefined): Promise<string> {
  if (!orgId) return appLinkOrigin(null);
  const org = await prisma.organization
    .findUnique({ where: { id: orgId }, select: { publicHost: true } })
    .catch(() => null);
  return appLinkOrigin(org?.publicHost ?? null);
}
