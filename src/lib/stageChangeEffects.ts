import { notifyIfAllowed } from '@/lib/notify';
import { dispatchWebhook } from '@/lib/webhooks';
import { PIPELINE_STATUSES } from '@/lib/pipeline';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { outcomeForStage } from '@/lib/outcomeComms';
import { emitOutcomeComms, notifyMenteeOfOutcome } from '@/lib/outcomeComms.server';
import { stageDeadlineUpdate } from '@/lib/stageSla';
import { prisma } from '@/lib/prisma';
import { verticalFor } from '@/lib/verticalContext';
import { verticalHasCapability } from '@/lib/verticals';
import { publishAfterCommit, type PublishInput } from '@/lib/events/publish';

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
  // The caller wrote the `pipeline.stage_change` DomainEvent in the same
  // transaction as the move (#1680) — `stageChangeEvent()` — so it must not be
  // written again here. Callers that cannot yet share their transaction leave
  // it unset and get the post-commit fallback below.
  eventPublished?: boolean;
  // Who moved it, for the event row. Null/absent = the system.
  actorId?: string | null;
}) {
  if (opts.from === opts.to) return;

  // The event record (#1680). Durable from here on, but NOT atomic with the
  // move when it lands here — the paths that still do are the burndown list in
  // docs/domain-events.md. Never throws: the move already committed.
  if (!opts.eventPublished) {
    await publishAfterCommit(
      stageChangeEvent({ relationId: opts.relationId, orgId: opts.orgId, from: opts.from, to: opts.to, actorId: opts.actorId }),
    );
  }

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

  // The mentee's half is portal content: an org without the `mentorship`
  // capability (a MARKETING sales book) has no portal, and its "mentee" is a
  // prospect — telling them "Qualified → Negotiation" would hand an outside
  // party the internal sales funnel, in a row only their data export would
  // ever show. The rep's side (outcome.needsMessage) and the webhook still run.
  const notifyMentee = !opts.skipNotify && verticalHasCapability(opts.orgId ? await verticalFor(opts.orgId) : null, 'mentorship');
  if (notifyMentee) {
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

  await dispatchWebhook('pipeline.stage_change', { relationId: opts.relationId, from: opts.from, to: opts.to }, opts.orgId);
}

/**
 * The `pipeline.stage_change` event of one move, for `publishEvent(tx, …)` /
 * `publishEventOp(…)` inside the move's own transaction (#1680). The payload
 * is the published v1 webhook shape, exactly.
 */
export function stageChangeEvent(opts: {
  relationId: string;
  orgId: string | null;
  from: string;
  to: string;
  actorId?: string | null;
}): PublishInput {
  return {
    name: 'pipeline.stage_change',
    payload: { relationId: opts.relationId, from: opts.from, to: opts.to },
    orgId: opts.orgId,
    actor: opts.actorId ? { id: opts.actorId, type: 'user' } : { id: null, type: 'system' },
  };
}
