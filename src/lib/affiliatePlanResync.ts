// The re-evaluation that follows a commission-plan change (docs/affiliate-module.md,
// #3170) — the I/O half. savePlan() commits the plan and a QUEUED state in one
// transaction and enqueues `affiliate.planResync`; this is the job's body. The
// rules of the state live in src/lib/affiliatePlanResyncRule.ts.
//
// Every partner goes through the ONE payment writer's resyncPartnerCommissions(),
// each in its own locked transaction, one at a time (one lock at a time keeps the
// database quiet for the payments being entered meanwhile). Nothing here writes a
// commission.
//
// AT-LEAST-ONCE: a rerun is harmless. The writer's reconciliation is idempotent
// (a second run over a partner changes nothing and reports the same drift), the
// state is the checkpoint (a rerun resumes after the cursor or runs the retry
// list), and every state write is guarded on the plan version — a job for an
// older version stops at its first write once a newer plan is saved.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resyncPartnerCommissions } from '@/lib/affiliatePaymentWriter';
import {
  RESYNC_END,
  beginAttempt,
  finishAttempt,
  parseResyncState,
  queuedResync,
  recordPassBatch,
  recordRetry,
  type PartnerOutcome,
  type PlanResyncState,
} from '@/lib/affiliatePlanResyncRule';

export const PLAN_RESYNC_BATCH = 100;
export const PLAN_RESYNC_MAX_ATTEMPTS = 5;

/** A guarded write of the state; false when a newer plan version took over. */
async function persist(orgId: string, state: PlanResyncState): Promise<boolean> {
  const { count } = await prisma.affiliateProgramSettings.updateMany({
    where: { orgId, planVersion: state.v },
    data: { planResync: state as unknown as Prisma.InputJsonValue },
  });
  return count === 1;
}

async function judge(orgId: string, partnerId: string, actorId: string): Promise<PartnerOutcome> {
  try {
    return { id: partnerId, ok: true, drift: (await resyncPartnerCommissions(orgId, partnerId, actorId)).drift.length };
  } catch {
    // A busy lock or a deadlock: retried by the job's next attempt.
    return { id: partnerId, ok: false, drift: 0 };
  }
}

export class PlanResyncIncomplete extends Error {
  constructor(readonly failed: number) {
    super(`plan_resync_partners_failed:${failed}`);
    this.name = 'PlanResyncIncomplete';
  }
}

/**
 * One attempt. Returns counters for the JobRun; throws PlanResyncIncomplete while
 * partners are outstanding and attempts remain, so the worker backs off and the
 * next attempt retries them.
 */
export async function runPlanResync(
  payload: { planVersion: number; actorId: string },
  orgId: string,
  ctx: { attempt: number; maxAttempts: number; signal: AbortSignal },
): Promise<Record<string, number>> {
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { planVersion: true, planResync: true } });
  if (!settings || settings.planVersion !== payload.planVersion) return { superseded: 1 };
  const stored = parseResyncState(settings.planResync);
  const current = stored && stored.v === payload.planVersion ? stored : queuedResync(payload.planVersion, new Date());
  if (current.status === 'DONE' || current.status === 'INCOMPLETE') return { alreadyFinished: 1 };

  const begun = beginAttempt(current, new Date());
  const mode = begun.mode;
  let state = begun.state;
  if (mode === 'pass' && state.cursor === null) state = { ...state, total: await prisma.affiliatePartner.count({ where: { orgId } }) };
  if (!(await persist(orgId, state))) return { superseded: 1 };

  if (mode === 'pass') {
    while (state.cursor !== RESYNC_END) {
      const batch = await prisma.affiliatePartner.findMany({
        where: { orgId, ...(state.cursor ? { id: { gt: state.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: PLAN_RESYNC_BATCH,
        select: { id: true },
      });
      if (batch.length === 0) break;
      const outcomes: PartnerOutcome[] = [];
      for (const p of batch) {
        // Aborted (timeout, shutdown): what this batch did is redone by the next
        // attempt from the last stored cursor — harmless, see the header.
        if (ctx.signal.aborted) throw new Error('plan_resync_aborted');
        outcomes.push(await judge(orgId, p.id, payload.actorId));
      }
      state = recordPassBatch(state, outcomes);
      if (!(await persist(orgId, state))) return { superseded: 1 };
    }
  } else {
    const outcomes: PartnerOutcome[] = [];
    for (const id of state.retry) {
      if (ctx.signal.aborted) throw new Error('plan_resync_aborted');
      outcomes.push(await judge(orgId, id, payload.actorId));
    }
    state = recordRetry(state, outcomes);
  }

  state = finishAttempt(state, ctx.attempt, ctx.maxAttempts, new Date());
  if (!(await persist(orgId, state))) return { superseded: 1 };
  if (state.status === 'RETRYING') throw new PlanResyncIncomplete(state.failed);
  return { partners: state.total ?? 0, resynced: state.done, failed: state.failed, drift: state.drift };
}
