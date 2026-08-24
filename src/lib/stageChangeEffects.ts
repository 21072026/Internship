import { notifyIfAllowed } from '@/lib/notify';
import { dispatchWebhook } from '@/lib/webhooks';
import { PIPELINE_STATUSES } from '@/lib/pipeline';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { outcomeForStage } from '@/lib/outcomeComms';
import { emitOutcomeComms, notifyMenteeOfOutcome } from '@/lib/outcomeComms.server';
import { stageDeadlineUpdate } from '@/lib/stageSla';
import { prisma } from '@/lib/prisma';

// The observable side of a pipeline stage change (#926): the mentee's in-app
// notification and the pipeline.stage_change webhook. Every write path that
// moves `MentorshipRelation.pipelineStatus` MUST route through this — before
// it existed, only PUT /api/mentorship/[id] emitted anything, so the same
// stage move was silent or loud depending on which screen made it.
//
// This deliberately does NOT write StatusChange/pipelineStatus itself: each
// caller has its own transaction shape (single update, bulk $transaction,
// backdated audit correction). The rule it enforces instead is the no-op
// guard (#894) and one consistent effects payload.
export async function emitStageChange(opts: {
  relationId: string;
  menteeId: string;
  orgId: string | null;
  from: string;
  to: string;
  // Suppress the mentee notification (webhook still fires) — used by bulk
  // advance to guarantee one notification per person when a mentee somehow
  // has two active relations in the batch.
  skipNotify?: boolean;
  // The drop-off reason recorded with this move (#810). It refines which
  // outcome wording is offered — a candidate who accepted elsewhere is
  // congratulated, not let down gently.
  reasonCode?: string | null;
  // The caller already wrote `stageDeadline` itself (an admin typed a date in
  // the same request). A hand-set date always beats the org's default (#817).
  deadlineSetByCaller?: boolean;
}) {
  if (opts.from === opts.to) return;

  // The notification stores stage KEYS; the renderer localizes built-in
  // stages at display time. Custom (per-org) stage keys have no dictionary
  // label, so snapshot their tenant-set labels into the params (#921).
  const stageParams: Record<string, string> = { from: opts.from, to: opts.to };
  const builtIn = PIPELINE_STATUSES as readonly string[];
  // A tenant may flag one of its own stages as off-path — that is an ending
  // too, so the outcome check needs the resolved stage either way.
  let toIsOffPath = false;
  if (!builtIn.includes(opts.from) || !builtIn.includes(opts.to)) {
    const stages = await resolvePipelineStages(opts.orgId);
    if (!builtIn.includes(opts.from)) {
      const label = stages.find((s) => s.key === opts.from)?.label;
      if (label) stageParams.fromLabel = label;
    }
    if (!builtIn.includes(opts.to)) {
      const label = stages.find((s) => s.key === opts.to)?.label;
      if (label) stageParams.toLabel = label;
    }
    toIsOffPath = stages.find((s) => s.key === opts.to)?.isOffPath ?? false;
  }

  // Reaching the end of the road is communicated as an outcome, not as a row
  // in a tracker (#830): the mentee gets wording that says where they stand,
  // *instead of* the generic stage line, and the mentor is handed a draft to
  // read, edit and send. Nothing goes out to the mentee automatically unless
  // the org turned that on.
  const outcome = outcomeForStage(opts.to, { isOffPath: toIsOffPath, reasonCode: opts.reasonCode });

  if (!opts.skipNotify) {
    if (outcome) await notifyMenteeOfOutcome(opts.menteeId, outcome);
    else await notifyIfAllowed(opts.menteeId, 'stageUpdates', 'stage.changed', stageParams, '/portal');
  }
  if (outcome && !opts.skipNotify) {
    await emitOutcomeComms({ relationId: opts.relationId, kind: outcome });
  }
  // The stage's service level (#817). This is the one place it can be applied
  // once and cover every write path: three endpoints move a pipelineStatus and
  // all three already route through here, so the SLA cannot be true on the
  // board and false in a bulk advance. Deliberately outside the caller's
  // transaction — `stageDeadline` is a derived convenience, and failing to
  // refresh it must never roll back the move itself.
  if (!opts.deadlineSetByCaller) {
    try {
      const update = await stageDeadlineUpdate(opts.orgId, opts.to);
      if (update) await prisma.mentorshipRelation.update({ where: { id: opts.relationId }, data: update });
    } catch (e) {
      console.error('Stage SLA deadline update failed:', e);
    }
  }

  await dispatchWebhook('pipeline.stage_change', { relationId: opts.relationId, from: opts.from, to: opts.to });
}
