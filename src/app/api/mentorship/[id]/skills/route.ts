import { NextResponse } from 'next/server';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { locales } from '@/i18n/config';
import { skillLevelsOf } from '@/lib/skillLevels';

// GET — the mentee's canonical skills with their levels and whether a mentor
// confirmed them (#1822), for the confirmation panel on the mentor's mentee
// page. The mentor of this relation, or an admin of its org; anything else is
// 403, the same answer the confirm route gives. Free core: no entitlement.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const gate = await requireRoleOrPermission(['MENTOR'], 'program.read', { request });
    if ('error' in gate) return gate.error;
    const { session, admin } = gate;
    const denied = await requireCapability(resolveOrgId(session), 'mentorship');
    if (denied) return denied;
    const { id } = await params;
    const raw = new URL(request.url).searchParams.get('locale') ?? 'en';
    const locale = (locales as readonly string[]).includes(raw) ? raw : 'en';

    return withTenantScope(session, async () => {
      const rel = await prisma.mentorshipRelation.findUnique({
        where: { id },
        select: { orgId: true, mentorId: true, menteeId: true, status: true },
      });
      const allowed = rel && (admin ? await inCallerTenant(rel.orgId, resolveOrgId(session)) : rel.mentorId === session.user.id);
      if (!rel || !allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      const skills = await skillLevelsOf(rel.menteeId, locale);
      // Confirming is for an ACTIVE pair only (the POST enforces it too).
      return NextResponse.json({ skills, canConfirm: rel.status === 'ACTIVE' });
    });
  });
}
