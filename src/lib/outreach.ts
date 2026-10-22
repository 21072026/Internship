// Company → candidate message requests (#1840) — the Prisma-aware half: who
// may see and decide which request, the request preconditions, and the
// approval's delivery. The pure rules are in src/lib/outreachRule.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { hasConsent } from '@/lib/consent';
import { SHORTLISTED_OR_LATER } from '@/lib/outreachRule';

/**
 * Which requests an actor may read and act on — the ONE rule, shared by the
 * list and the decision route. ADMIN: the org's. MENTOR: those of candidates
 * they actively mentor. MENTEE: their own. COMPANY: their company's. Anything
 * else: none (a route answers 404 for a row outside it, never 403).
 */
export function outreachActorWhere(actor: { role: string; userId: string; orgId: string; companyId?: string | null }): Prisma.CandidateOutreachWhereInput | null {
  switch (actor.role) {
    case 'ADMIN':
      return { orgId: actor.orgId };
    case 'MENTOR':
      return { orgId: actor.orgId, mentee: { menteeRelations: { some: { mentorId: actor.userId, status: 'ACTIVE', orgId: actor.orgId } } } };
    case 'MENTEE':
      return { orgId: actor.orgId, menteeId: actor.userId };
    case 'COMPANY':
      return actor.companyId ? { orgId: actor.orgId, companyId: actor.companyId } : null;
    default:
      return null;
  }
}

export type OutreachPrecondition = 'not_shortlisted' | 'no_consent';

/**
 * The two facts a company must meet before it may ask, both read from the
 * database, never from the request: the candidate is shortlisted by THIS
 * company (an Application on one of its requisitions at SHORTLISTED or later,
 * or a SHORTLISTED CompanyInterest), and has an active TALENT_POOL_VISIBILITY
 * consent. Returns the shortlisted application's id when there is one.
 */
export async function outreachPreconditions(
  orgId: string,
  companyId: string,
  menteeId: string,
): Promise<{ ok: true; applicationId: string | null } | { ok: false; code: OutreachPrecondition }> {
  const [application, interest] = await Promise.all([
    prisma.application.findFirst({
      where: { orgId, menteeId, stage: { in: [...SHORTLISTED_OR_LATER] }, companyId },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.companyInterest.findFirst({ where: { companyId, menteeId, status: 'SHORTLISTED', mentee: { orgId } }, select: { id: true } }),
  ]);
  if (!application && !interest) return { ok: false, code: 'not_shortlisted' };
  if (!(await hasConsent(menteeId, 'TALENT_POOL_VISIBILITY'))) return { ok: false, code: 'no_consent' };
  return { ok: true, applicationId: application?.id ?? null };
}
