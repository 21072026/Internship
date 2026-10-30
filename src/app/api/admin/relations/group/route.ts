import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { checkActiveRelationLimit, planLimitError } from '@/lib/planGate';
import { resolveStartStage } from '@/lib/pipelineStages';
import { stageTrialWindow } from '@/lib/trialWindow';
import { DEFAULT_RELATION_KIND } from '@/lib/placementKind';
import { AlreadyMentoredError, alreadyMentoredBody } from '@/lib/activeMentorship';
import { announceNewRelation, createGuardedRelation } from '@/lib/relationCreate';
import { addSeat } from '@/lib/relationParticipants';
import { checkGroupMembers, GROUP_MAX_MENTEES } from '@/lib/relationShapes';
import { assertNotMentored, assertSeatableMentee, assertSeatableMentor, GroupRefusal } from '@/lib/groupRelations';
import { scheduleCreateData } from '@/lib/relationSchedule';
import { relationScheduleDefaults } from '@/lib/relationScheduleDefaults';
import { getLocale } from '@/i18n/server';

// POST — form a GROUP (#1804): one mentor, 2…25 mentees, ONE relation. The
// first mentee is the scalar pair's mentee (the shared create path writes it
// with its guard and mirror seats); every other mentee is a seat. All of it in
// one transaction, each mentee asked the one-active-mentor question (#419)
// inside it — one refusal rolls the whole group back, never half a group.
//
// One relation counts once against the plan cap (#547) and the billing meter
// (#1750): both count relations, and a group is one.
const schema = z.object({
  mentorId: z.string().min(1),
  menteeIds: z.array(z.string().min(1)).min(1).max(GROUP_MAX_MENTEES + 1),
});

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('relation.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const denied = await requireCapability(session.user.orgId, 'mentorship');
    if (denied) return denied;

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    const { mentorId, menteeIds } = parsed.data;
    const shape = checkGroupMembers(mentorId, menteeIds);
    if (shape) return NextResponse.json({ error: 'Not a valid group', code: shape }, { status: 400 });

    return withTenantScope(session, async () => {
      const tenant = await tenantWhere(session);
      const people = await prisma.user.findMany({ where: withinTenant({ id: { in: [mentorId, ...menteeIds] } }, tenant) });
      const byId = new Map(people.map((u) => [u.id, u]));
      const [first, ...rest] = menteeIds;
      const mentor = byId.get(mentorId);
      const firstMentee = byId.get(first);

      try {
        assertSeatableMentor(mentor, mentorId);
        for (const id of menteeIds) await assertSeatableMentee(byId.get(id), id);
      } catch (e) {
        if (e instanceof GroupRefusal) return NextResponse.json({ error: 'Refused', code: e.code, ...e.detail }, { status: e.status });
        throw e;
      }

      const orgId = firstMentee!.orgId;
      const plan = await checkActiveRelationLimit(orgId);
      if (!plan.allowed) return NextResponse.json(planLimitError(plan), { status: 403 });

      const start = new Date();
      const pipelineStatus = await resolveStartStage(orgId);
      const trialWindow = await stageTrialWindow({ orgId, toStage: pipelineStatus, enteredAt: start });
      const schedule = scheduleCreateData({}, start, await relationScheduleDefaults(orgId));

      let relation;
      try {
        relation = await prisma.$transaction(async (tx) => {
          // Every further mentee first, so a refusal names whoever is in the way
          // before anything is written; the pair's guard runs in createGuardedRelation.
          for (const id of rest) await assertNotMentored(tx, id);
          const created = await createGuardedRelation(tx, {
            mentorId,
            menteeId: first,
            orgId,
            relationType: 'GROUP',
            pipelineStatus,
            ...trialWindow,
            startDate: start,
            ...schedule,
            kind: DEFAULT_RELATION_KIND,
            funnelEnteredAt: DEFAULT_RELATION_KIND === 'PLACEMENT' ? start : null,
          });
          for (const id of rest) await addSeat(tx, created.id, id, 'MENTEE');
          return created;
        });
      } catch (e) {
        if (e instanceof AlreadyMentoredError) {
          return NextResponse.json({ ...(await alreadyMentoredBody(prisma, e.existingRelationId)), menteeId: e.menteeId }, { status: 409 });
        }
        throw e;
      }

      // After the commit: the pair's announcement once (the event, the
      // decision, both sides' notices and mails), then each seated mentee's —
      // their own decision record, notice and mail, no second event.
      const locale = await getLocale();
      const actor = { id: session.user.id, orgId: session.user.orgId ?? null };
      for (const [i, id] of menteeIds.entries()) {
        await announceNewRelation({
          relation,
          mentor: mentor!,
          mentee: byId.get(id)!,
          companyId: null,
          actor,
          decision: { source: 'ADMIN_DIRECT', note: null, locale },
          seat: i > 0,
        });
      }

      return NextResponse.json({ relation: { id: relation.id, relationType: 'GROUP' }, menteeCount: menteeIds.length }, { status: 201 });
    });
  });
}
