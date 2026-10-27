import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { canPerformApplicationAction, canTransition } from '@/lib/applications';
import { moveApplicationStage } from '@/lib/applicationStage';
import { CONSENTING_POOL_WHERE } from '@/lib/requisitionMatchRule';

const bodySchema = z.object({ menteeId: z.string().trim().min(1).max(64) }).strict();

/** A role that is no longer hiring takes no new shortlist entries. */
const CLOSED_STATUSES = ['FILLED', 'CANCELLED'];

// POST — an admin puts a candidate on a requisition's shortlist (#1401). The
// shortlist IS the Application at SHORTLISTED (#1828/#1836), so this never
// writes CompanyInterest — that row stays the company's own flag — and "who
// added it" is the application's `source: 'ADMIN'` plus the actor on its
// ApplicationEvent.
//
//   - no application yet → created at SHORTLISTED with source ADMIN and its
//     first event (the @@unique([requisitionId, menteeId]) decides a race: the
//     loser answers 409 stage_conflict);
//   - an application before SHORTLISTED → moved through moveApplicationStage(),
//     the one writer of `stage`, after canPerformApplicationAction();
//   - already at or past SHORTLISTED, or terminal → left alone, 200 moved:false.
//
// Taking someone OFF the shortlist is a stage move like any other — PATCH
// /api/applications/[id]/stage to REJECTED with a disposition code — so there
// is no second removal path here.
//
// Only a candidate of the consenting talent pool (requisitionMatchRule.ts) may
// be added: the company reads this shortlist, and a candidate without consent
// must not appear in it (409 no_consent). A requisition or a candidate of
// another org is a 404. ADMIN through requirePermission('company.write') —
// ORG_ADMIN; an OBSERVER reads, it does not shortlist.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const auth = await requirePermission('company.write', { request });
    if ('error' in auth) return auth.error;
    const { session } = auth;
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const { menteeId } = parsed.data;
    const { id } = await params;

    return withTenantScope(session, async () => {
      const requisition = await prisma.requisition.findFirst({ where: { id, orgId }, select: { id: true, companyId: true, status: true } });
      if (!requisition) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (CLOSED_STATUSES.includes(requisition.status)) {
        return NextResponse.json({ error: 'This requisition is closed', code: 'requisition_closed' }, { status: 409 });
      }
      const mentee = await prisma.user.findFirst({ where: { id: menteeId, orgId, role: 'MENTEE' }, select: { id: true } });
      if (!mentee) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const consenting = await prisma.user.count({ where: { ...CONSENTING_POOL_WHERE, id: menteeId, orgId } });
      if (consenting === 0) {
        return NextResponse.json({ error: 'The candidate has not agreed to be shown to companies', code: 'no_consent' }, { status: 409 });
      }

      type Outcome = { applicationId: string; created: boolean; moved: boolean; fromStage: string | null; stage: string } | { conflict: true };
      let outcome: Outcome;
      try {
        outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
          const existing = await tx.application.findUnique({
            where: { requisitionId_menteeId: { requisitionId: requisition.id, menteeId } },
            select: { id: true, stage: true },
          });
          if (!existing) {
            const created = await tx.application.create({
              data: {
                orgId,
                requisitionId: requisition.id,
                menteeId,
                companyId: requisition.companyId,
                source: 'ADMIN',
                stage: 'SHORTLISTED',
                status: 'ACTIVE',
                events: { create: { fromStage: null, toStage: 'SHORTLISTED', actorId: session.user.id, note: 'admin shortlist' } },
              },
              select: { id: true },
            });
            return { applicationId: created.id, created: true, moved: true, fromStage: null, stage: 'SHORTLISTED' };
          }
          if (!canTransition(existing.stage, 'SHORTLISTED')) {
            return { applicationId: existing.id, created: false, moved: false, fromStage: existing.stage, stage: existing.stage };
          }
          const allowed = canPerformApplicationAction({ role: 'ADMIN', isOwnApplication: false, isOwningCompany: false, from: existing.stage, to: 'SHORTLISTED' });
          if (!allowed) return { applicationId: existing.id, created: false, moved: false, fromStage: existing.stage, stage: existing.stage };
          const moved = await moveApplicationStage(tx, {
            applicationId: existing.id,
            expectedStage: existing.stage,
            toStage: 'SHORTLISTED',
            actorId: session.user.id,
            note: 'admin shortlist',
          });
          if (!moved.ok) return { conflict: true };
          return { applicationId: existing.id, created: false, moved: true, fromStage: existing.stage, stage: 'SHORTLISTED' };
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') outcome = { conflict: true };
        else throw error;
      }
      if ('conflict' in outcome) {
        return NextResponse.json({ error: 'Someone else changed this application first', code: 'stage_conflict' }, { status: 409 });
      }

      if (outcome.moved) {
        await logActivity({
          action: 'application.shortlist.add',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'application',
          targetId: outcome.applicationId,
          detail: `${outcome.fromStage ?? 'new'} -> SHORTLISTED; requisition=${requisition.id}; mentee=${menteeId}; via=admin`,
          request,
          orgId,
        });
      }
      return NextResponse.json(
        { applicationId: outcome.applicationId, created: outcome.created, moved: outcome.moved, stage: outcome.stage },
        { status: outcome.created ? 201 : 200 },
      );
    });
  });
}
