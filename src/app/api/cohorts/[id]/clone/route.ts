import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { enforceQuota } from '@/lib/quota';
import { quotaError } from '@/lib/quotaRule';
import { logActivity } from '@/lib/activity';
import { cloneEligibilityRules, cloneSlaRows, cloneSteps } from '@/lib/programCloneRule';
import { announceSettingCopies, copyProgramSettingsTx } from '@/lib/settingsWrite';

// POST /api/cohorts/[id]/clone — a programme for the next intake (#1643).
//
// Copies the source programme's CONFIGURATION into a new programme in ONE
// transaction; what is configuration and what is a person is decided in
// src/lib/programCloneRule.ts, never here. Nothing that identifies a person is
// read or written: no relations, members, grants, match rounds, costs, events.
//
// WHO: `program.write` on the SOURCE programme — an org admin, or a
// PROGRAM_ADMIN holding a grant for it. The new programme does NOT get a grant:
// handing out scope is the org admin's act (AdminScopeGrant), and a clone that
// widened its author's reach would be a way around that. So a PROGRAM_ADMIN can
// start the next intake but needs an org admin to be given it.
//
// The org is the session's; another org's programme reads as 404.

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  term: z.string().trim().max(60).optional().nullable(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orgId = resolveOrgId(await getServerSession(authOptions));
  const gate = await requirePermission('program.write', { request, subject: { orgId, cohortId: id } });
  if ('error' in gate) return gate.error;
  const { session, actor } = gate;
  if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
  const gated = await requireCapability(orgId, 'mentorship');
  if (gated) return gated;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  return withTenantScope(session, async () => {
    const source = await prisma.cohort.findFirst({ where: { id, orgId }, select: { id: true, name: true, eligibilityMode: true } });
    if (!source) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // A clone is a new programme: the plan's programme band (#1752) applies.
    const programs = await enforceQuota(orgId, 'PROGRAMS');
    if (!programs.allowed) return NextResponse.json(quotaError(programs), { status: 403 });

    const actorRef = { id: actor.id, email: session.user?.email ?? null };
    const { cohort, counts, settingCopies } = await prisma.$transaction(async (tx) => {
      const [slas, rules, steps] = await Promise.all([
        tx.stageSla.findMany({
          where: { orgId, cohortId: source.id },
          select: { stageKey: true, days: true, wipLimit: true, escalateAfterDays: true, cohortId: true, mentorId: true },
        }),
        tx.programEligibilityRule.findMany({
          where: { orgId, programId: source.id },
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
          select: { effect: true, attribute: true, operator: true, value: true, priority: true, active: true, appliesTo: true },
        }),
        tx.programStep.findMany({
          where: { programId: source.id },
          orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
          select: {
            order: true, milestone: true, anchor: true, offsetDays: true, audience: true, action: true,
            payload: true, title: true, translations: true, publishedAt: true, archivedAt: true,
          },
        }),
      ]);

      const created = await tx.cohort.create({
        data: { orgId, name: parsed.data.name, term: parsed.data.term || null, eligibilityMode: source.eligibilityMode },
      });
      const slaRows = cloneSlaRows(slas, orgId, created.id);
      const ruleRows = cloneEligibilityRules(rules, orgId, created.id, actor.id);
      const stepRows = cloneSteps(steps, orgId, created.id);
      if (slaRows.length) await tx.stageSla.createMany({ data: slaRows });
      // createMany cannot take a Json column typed as unknown; one create each.
      for (const r of ruleRows) await tx.programEligibilityRule.create({ data: { ...r, value: r.value as never } });
      for (const s of stepRows) {
        await tx.programStep.create({
          data: { ...s, payload: (s.payload ?? undefined) as never, translations: (s.translations ?? undefined) as never },
        });
      }
      const copies = await copyProgramSettingsTx(tx, orgId, source.id, created.id, actorRef);

      const tally = { stageSlas: slaRows.length, eligibilityRules: ruleRows.length, steps: stepRows.length, settings: copies.length };
      await tx.auditLog.create({
        data: {
          orgId,
          actorId: actor.id,
          action: 'PROGRAM_CLONE',
          detail: JSON.stringify({ from: source.id, to: created.id, ...tally }),
        },
      });
      return { cohort: created, counts: tally, settingCopies: copies };
    });

    await announceSettingCopies(settingCopies, actorRef);
    await logActivity({
      action: 'program.cloned',
      actorId: actor.id,
      targetType: 'Cohort',
      targetId: cohort.id,
      detail: `${source.name} → ${cohort.name}`,
      request,
    });
    return NextResponse.json({ cohort, copied: counts }, { status: 201 });
  });
}
