import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { auditRangeFrom, auditTargetsWhere } from '@/lib/auditViewRule';
import type { Actor, ScopeGrant } from '@/lib/authzRule';

// The audit trail's filter (#1583), shared by the viewer (GET /api/admin/audit)
// and its CSV export (#1585). ONE builder on purpose: an export whose filter is
// a copy of the viewer's is a file that drifts from the screen it claims to
// export — the first new filter added to one and not the other makes it lie.
//
// The org is the caller's own (tenantWhere(session)), never the query string,
// and a PROGRAM_ADMIN is narrowed to the rows about a person inside its grants.
export async function auditWhereFor(
  sp: URLSearchParams,
  gate: { session: Session; actor: Actor; grants?: ScopeGrant[] },
): Promise<{ where: Prisma.AuditLogWhereInput; tenant: Awaited<ReturnType<typeof tenantWhere>> } | 'invalid_date'> {
  const { session, actor, grants } = gate;
  const action = sp.get('action')?.trim();
  const actorQ = sp.get('actor')?.trim();
  const targetId = sp.get('targetId')?.trim();
  const range = auditRangeFrom(sp.get('from'), sp.get('to'));
  if (range === 'invalid') return 'invalid_date';

  const tenant = await tenantWhere(session);
  const terms: Prisma.AuditLogWhereInput[] = [];
  if (action) terms.push({ action: { contains: action } });
  if (targetId) terms.push({ targetId });
  if (range) terms.push({ createdAt: range });
  if (actorQ) {
    // AuditLog stores the actor's id only: resolve the e-mail filter to the
    // tenant's matching accounts. An actor whose account is gone is not
    // findable by e-mail — their rows still show, with the bare id.
    const actors = await prisma.user.findMany({
      where: withinTenant<Prisma.UserWhereInput>({ email: { contains: actorQ } }, tenant),
      select: { id: true },
      take: 500,
    });
    terms.push({ actorId: { in: actors.map((a) => a.id) } });
  }
  if (actor.adminLevel === 'PROGRAM_ADMIN') {
    // Only rows about a person inside the grants (their relations' cohort /
    // company, or a company's own account). Rows with no target are org-wide
    // and stay out.
    const people = await prisma.user.findMany({
      where: withinTenant<Prisma.UserWhereInput>(auditTargetsWhere(grants ?? []), tenant),
      select: { id: true },
      take: 5000,
    });
    terms.push({ targetId: { in: people.map((p) => p.id) } });
  }
  return { where: withinTenant<Prisma.AuditLogWhereInput>(terms.length ? { AND: terms } : {}, tenant), tenant };
}
