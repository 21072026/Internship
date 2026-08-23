import { notifyIfAllowed } from '@/lib/notify';
import { dispatchWebhook } from '@/lib/webhooks';
import { PIPELINE_STATUSES } from '@/lib/pipeline';
import { resolvePipelineStages } from '@/lib/pipelineStages';

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
}) {
  if (opts.from === opts.to) return;

  // The notification stores stage KEYS; the renderer localizes built-in
  // stages at display time. Custom (per-org) stage keys have no dictionary
  // label, so snapshot their tenant-set labels into the params (#921).
  const stageParams: Record<string, string> = { from: opts.from, to: opts.to };
  const builtIn = PIPELINE_STATUSES as readonly string[];
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
  }

  if (!opts.skipNotify) {
    await notifyIfAllowed(opts.menteeId, 'stageUpdates', 'stage.changed', stageParams, '/portal');
  }
  await dispatchWebhook('pipeline.stage_change', { relationId: opts.relationId, from: opts.from, to: opts.to });
}
