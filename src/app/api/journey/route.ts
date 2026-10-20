import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { inCallerTenant } from '@/lib/tenantFilter';
import { loadOnboardingState, ONBOARDING_STEPS } from '@/lib/menteeOnboarding';
import { previewJourney, satisfactionEvidence } from '@/lib/programJourney';
import { participantGroup, readStepTranslations, satisfiedCondition, type JourneySkipCondition } from '@/lib/programJourneyRule';

// GET ?relationId= — the participant journey (#1855): one forward-looking list
// for the pair, the same for both seats, so the mentor and the mentee always see
// the same dates. The six onboarding steps (src/lib/menteeOnboarding.ts) are its
// first milestone; the programme's published steps follow, grouped now / next /
// done by participantGroup(). A satisfied step carries its evidence (what
// happened, and when) instead of asking again.
//
// Authorized by relation membership, never by role alone: the relation's mentor,
// its mentee, or an ADMIN of its tenant. Another relation of the caller's tenant
// answers 403; another tenant's answers like a missing one (#2542).
// Read-only: nothing here claims a run (previewJourney, #1853).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const relationId = new URL(request.url).searchParams.get('relationId') ?? '';
    const rel = relationId
      ? await prisma.mentorshipRelation.findUnique({ where: { id: relationId }, select: { id: true, orgId: true, mentorId: true, menteeId: true, cohortId: true } })
      : null;
    if (!rel || !(await inCallerTenant(rel.orgId, session.user.orgId))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const seat = rel.mentorId === session.user.id ? 'MENTOR' : rel.menteeId === session.user.id ? 'MENTEE' : session.user.role === 'ADMIN' ? 'ADMIN' : null;
    if (!seat) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const now = new Date();
    const onboarding = await loadOnboardingState(rel.mentorId, rel.menteeId);
    const timeline = rel.cohortId ? (await previewJourney(rel.cohortId, rel.id, now)) ?? [] : [];
    const visible = timeline.flatMap(({ stepId, entry }) => {
      const group = participantGroup(entry.status);
      return group ? [{ stepId, entry, group }] : [];
    });
    const steps = visible.length
      ? await prisma.programStep.findMany({
          where: { id: { in: visible.map((v) => v.stepId) } },
          select: { id: true, milestone: true, action: true, audience: true, title: true, translations: true, offsetDays: true },
        })
      : [];
    const byId = new Map(steps.map((s) => [s.id, s]));
    const conditions = visible.flatMap((v) => {
      const c = satisfiedCondition(v.entry.reason);
      return c ? [c] : [];
    });
    const evidence = await satisfactionEvidence(rel.id, conditions);

    return NextResponse.json({
      seat,
      onboarding: onboarding
        ? ONBOARDING_STEPS.map((key) => ({ key, done: onboarding.steps[key].done, observed: onboarding.steps[key].auto }))
        : [],
      steps: visible.flatMap(({ stepId, entry, group }) => {
        const s = byId.get(stepId);
        if (!s) return [];
        const cond: JourneySkipCondition | null = satisfiedCondition(entry.reason);
        return [{
          id: s.id,
          milestone: s.milestone,
          action: s.action,
          audience: s.audience,
          title: s.title,
          translations: readStepTranslations(s.translations),
          group,
          status: entry.status,
          dueAt: entry.dueAt?.toISOString() ?? null,
          evidence: cond ? { condition: cond, at: evidence[cond]?.toISOString() ?? null } : null,
        }];
      }),
    });
  });
}
