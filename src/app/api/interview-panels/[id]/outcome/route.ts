import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { emit } from '@/lib/events/emit';
import { notifyIfAllowed } from '@/lib/notify';
import { findActiveMentorship } from '@/lib/activeMentorship';
import { isDispositionCode, requiresDispositionCode } from '@/lib/applications';
import { moveApplicationStage } from '@/lib/applicationStage';
import { isInterviewOutcome, outcomeMayAdvancePipeline, outcomeNotificationKey, outcomeTargetStage } from '@/lib/interviewOutcome';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { onPathKeys } from '@/lib/pipeline';
import { validateDropoffReason } from '@/lib/stageChange';
import { recordStageMove, stageMoveData } from '@/lib/stageMove';

const bodySchema = z.object({
  decision: z.string().trim().min(1).max(16),
  applicationId: z.string().trim().min(1).max(64),
  dispositionCode: z.string().trim().max(32).optional(),
  note: z.string().trim().max(1000).optional(),
  /** "Also move the pipeline stage": explicit, never implied (the convention of src/lib/offers.ts). */
  advancePipeline: z.boolean().optional(),
}).strict();

class Refused extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

type PipelineResult = { moved: boolean; from: string; to: string | null; reason?: string };

// The relation's pipeline stage, moved ONE on-path step through the shared
// stage write path — only when the actor asked for it. Every skip is named.
async function advanceRelationStage(relationId: string, actor: { id: string; email: string | null }, cause: string): Promise<PipelineResult> {
  const relation = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    select: { id: true, menteeId: true, orgId: true, pipelineStatus: true, status: true, trialStartedAt: true, trialEndsAt: true },
  });
  if (!relation) return { moved: false, from: '', to: null, reason: 'not_active' };
  if (relation.status !== 'ACTIVE') return { moved: false, from: relation.pipelineStatus, to: null, reason: 'not_active' };
  const path = onPathKeys(await resolvePipelineStages(relation.orgId));
  const index = path.indexOf(relation.pipelineStatus);
  const to = index >= 0 && index + 1 < path.length ? path[index + 1] : null;
  if (!to) return { moved: false, from: relation.pipelineStatus, to: null, reason: 'no_next_stage' };
  const reasonCheck = await validateDropoffReason({ orgId: relation.orgId, toStatus: to });
  if (!reasonCheck.ok) return { moved: false, from: relation.pipelineStatus, to, reason: 'reason_required' };
  const moved = await prisma.mentorshipRelation.updateMany({
    where: { id: relation.id, pipelineStatus: relation.pipelineStatus, status: 'ACTIVE' },
    data: await stageMoveData(relation, to),
  });
  if (moved.count === 0) return { moved: false, from: relation.pipelineStatus, to, reason: 'changed_meanwhile' };
  await recordStageMove({ relation, toStatus: to, actor, cause });
  return { moved: true, from: relation.pipelineStatus, to };
}

// POST — the decision a CLOSED panel produced (#1846): ADVANCE, REJECT or
// OFFER moves the candidate's application through the one stage writer
// (moveApplicationStage), is sealed on the panel exactly once, and is told to
// the company as a decision — never a score, never a divergence flag. The
// relation's pipeline stage moves only on an explicit `advancePipeline`.
// Actors: ADMIN, or the candidate's active MENTOR (the interview-request rule).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Placement write (#2364).
    const capGate = await requireCapability(session.user.orgId, 'placements');
    if (capGate) return capGate;
    const role = session.user.role;
    if (role !== 'ADMIN' && role !== 'MENTOR') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'validation_failed' }, { status: 400 });
    const { decision, applicationId, dispositionCode, note, advancePipeline } = parsed.data;
    if (!isInterviewOutcome(decision)) return NextResponse.json({ error: 'Unknown decision', code: 'unknown_decision' }, { status: 400 });
    const { id } = await params;

    return withTenantScope(session, async () => {
      const panel = await prisma.interviewPanel.findUnique({
        where: { id },
        select: { id: true, orgId: true, subjectId: true, closedAt: true, outcome: true },
      });
      if (!panel || (panel.orgId && panel.orgId !== orgId)) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      const relation = await findActiveMentorship(prisma, panel.subjectId);
      if (role === 'MENTOR' && relation?.mentorId !== session.user.id) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
      // The scorecards decide first: no outcome pre-empts an open collection.
      if (!panel.closedAt) return NextResponse.json({ error: 'The panel is still collecting scorecards', code: 'panel_open' }, { status: 409 });
      if (panel.outcome) return NextResponse.json({ error: 'An outcome is already recorded', code: 'outcome_recorded', outcome: panel.outcome }, { status: 409 });

      const application = await prisma.application.findFirst({
        where: { id: applicationId, orgId, menteeId: panel.subjectId },
        select: { id: true, stage: true, requisitionId: true, companyId: true, requisition: { select: { title: true } } },
      });
      if (!application) return NextResponse.json({ error: 'Application not found', code: 'application_not_found' }, { status: 404 });
      const target = outcomeTargetStage(decision, application.stage);
      if (!target) {
        return NextResponse.json({ error: `Cannot ${decision} from ${application.stage}`, code: 'invalid_transition', stage: application.stage }, { status: 400 });
      }
      if (requiresDispositionCode(target) && (!dispositionCode || !isDispositionCode(dispositionCode))) {
        return NextResponse.json({ error: 'A valid dispositionCode is required', code: 'disposition_required' }, { status: 400 });
      }
      const code = requiresDispositionCode(target) && dispositionCode && isDispositionCode(dispositionCode) ? dispositionCode : null;
      const now = new Date();

      let move: { fromStage: string; toStage: string };
      try {
        move = await prisma.$transaction(async (tx) => {
          const result = await moveApplicationStage(tx, {
            applicationId: application.id,
            expectedStage: application.stage,
            toStage: target,
            actorId: session.user.id,
            note,
            dispositionCode: code,
            now,
          });
          if (!result.ok) throw new Refused(result.reason);
          // Sealed once: the WHERE carries "no outcome yet, closed", so two
          // decisions racing each other produce one outcome and one 409.
          const sealed = await tx.interviewPanel.updateMany({
            where: { id: panel.id, outcome: null, closedAt: { not: null } },
            data: { outcome: decision, outcomeAt: now, outcomeById: session.user.id, outcomeApplicationId: application.id },
          });
          if (sealed.count !== 1) throw new Refused('outcome_recorded');
          await tx.auditLog.create({
            data: {
              actorId: session.user.id,
              action: 'INTERVIEW_PANEL_OUTCOME',
              targetId: panel.id,
              orgId,
              detail: `${decision}; application=${application.id}; ${result.fromStage} -> ${result.toStage}${code ? `; reason=${code}` : ''}`,
            },
          });
          return { fromStage: result.fromStage, toStage: result.toStage };
        });
      } catch (e) {
        if (e instanceof Refused) {
          const status = e.code === 'stage_conflict' || e.code === 'outcome_recorded' ? 409 : 400;
          return NextResponse.json({ error: 'The outcome could not be recorded', code: e.code }, { status });
        }
        throw e;
      }

      await logActivity({
        action: 'application.stage.set',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'application',
        targetId: application.id,
        detail: `${move.fromStage} -> ${move.toStage}${code ? `; reason=${code}` : ''}; via=interview_panel.outcome`,
        request,
        orgId,
      });
      await logActivity({
        action: 'interview_panel.outcome',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'interviewPanel',
        targetId: panel.id,
        detail: `${decision}; application=${application.id}`,
        request,
        orgId,
      });

      // The company hears the decision — and nothing else from the panel.
      const companyUsers = await prisma.user.findMany({
        where: { orgId, companyId: application.companyId, role: 'COMPANY', isActive: true },
        select: { id: true },
      });
      for (const user of companyUsers) {
        await notifyIfAllowed(user.id, 'mentorship', outcomeNotificationKey(decision), { title: application.requisition.title }, `/company/requisitions/${application.requisitionId}`);
      }

      // "Recommend, never apply": the pipeline moves only when asked, and a
      // rejection by one company never moves a person's programme stage.
      const pipeline: PipelineResult | null =
        advancePipeline && outcomeMayAdvancePipeline(decision) && relation
          ? await advanceRelationStage(relation.id, { id: session.user.id, email: session.user.email ?? null }, `interview panel ${panel.id} outcome ${decision}`)
          : null;
      // The decision only (#1998) — never a score, a note or a disposition
      // code: the same line the company's notification holds.
      await emit('interview_panel.outcome', { panelId: panel.id, applicationId: application.id, outcome: decision }, { orgId, actor: { id: session.user.id, type: 'user' } });

      return NextResponse.json({
        ok: true,
        outcome: decision,
        application: { id: application.id, fromStage: move.fromStage, stage: move.toStage },
        pipeline,
      });
    });
  });
}
