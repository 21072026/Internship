import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { SKILL_LEVEL_MAX, SKILL_LEVEL_MIN } from '@/lib/skillLevelRule';
import { confirmSkillLevel } from '@/lib/skillLevels';

// POST — a mentor confirms (or corrects) their mentee's level on one skill
// (#1822). Authorized from the relation, server-side: the mentor of THIS
// relation while it is ACTIVE, or an admin of its org. Another mentor — or the
// mentor of an ended pair — gets 403; hiding the button is not the check.
// The level is the confirmer's statement, so it is required: a confirmation
// always names the value it vouches for. Free core: never entitlement-gated.
const schema = z.object({ level: z.number().int().min(SKILL_LEVEL_MIN).max(SKILL_LEVEL_MAX) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string; skillId: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const denied = await requireCapability(resolveOrgId(session), 'mentorship');
    if (denied) return denied;
    const { id, skillId } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'invalid_level' }, { status: 400 });

    return withTenantScope(session, async () => {
      const rel = await prisma.mentorshipRelation.findUnique({
        where: { id },
        select: { orgId: true, mentorId: true, menteeId: true, status: true },
      });
      const allowed =
        rel &&
        rel.status === 'ACTIVE' &&
        (session.user.role === 'ADMIN' ? await inCallerTenant(rel.orgId, resolveOrgId(session)) : rel.mentorId === session.user.id);
      if (!rel || !allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      const outcome = await confirmSkillLevel({
        userId: rel.menteeId,
        skillId,
        level: parsed.data.level,
        actorId: session.user.id,
      });
      if (!outcome.ok && outcome.reason === 'missing') return NextResponse.json({ error: 'Not found', code: 'skill_not_held' }, { status: 404 });
      if (!outcome.ok) return NextResponse.json({ error: 'Changed meanwhile', code: 'level_conflict' }, { status: 409 });
      return NextResponse.json({ ok: true, changed: outcome.changed });
    });
  });
}
