// The stage-automation evaluator bound to the database (#1703). Server-only.
//
// `evaluateAutomationEvent()` is the body of the `automation` subscriber
// (src/lib/events/subscribers/automation.ts) on `pipeline.stage_change`; `runDelayedAutomation()` is the `automation.run`
// job (src/jobs/index.ts) for a rule with a delay. The rules themselves are in
// ./engine.ts (orchestration) and ./rule.ts (vocabulary) — this file only reads
// and writes rows. Every query names the run's `orgId` itself AND runs inside
// `runWithOrg(orgId, …)`: the worker has no session, and with
// MT_ENFORCE_ISOLATION on the bound context is what scopes the TENANT_MODELS.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { enqueue } from '@/lib/jobs/queue';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { outcomeForStage } from '@/lib/outcomeComms';
import type { DeliveredEvent } from '@/lib/events/subscribers';
import { evaluateStageEvent, executeRun, type AutomationStore } from './engine';
import { executeAutomationAction } from './actions';

const ruleSelect = {
  id: true,
  orgId: true,
  name: true,
  trigger: true,
  stageKey: true,
  conditions: true,
  actions: true,
  delayMinutes: true,
  enabled: true,
} as const;

/** Is `stageKey` an ending in this org's pipeline? Same test as stageChangeEffects.ts. */
export async function isOutcomeStageFor(orgId: string, stageKey: string): Promise<boolean> {
  const stage = (await resolvePipelineStages(orgId)).find((s) => s.key === stageKey);
  return outcomeForStage(stageKey, { isOffPath: stage?.isOffPath ?? false }) !== null;
}

export const prismaAutomationStore: AutomationStore = {
  loadRules: (orgId, stageKeys) =>
    prisma.automationRule.findMany({ where: { orgId, enabled: true, stageKey: { in: stageKeys } }, select: ruleSelect, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }),
  loadRule: (ruleId) => prisma.automationRule.findUnique({ where: { id: ruleId }, select: ruleSelect }),
  loadRelation: (relationId) =>
    prisma.mentorshipRelation.findUnique({
      where: { id: relationId },
      select: { id: true, orgId: true, kind: true, companyId: true, pipelineStatus: true, mentorId: true, menteeId: true, startDate: true },
    }),
  stageEnteredAt: async (relationId, stage, before) => {
    const row = await prisma.statusChange.findFirst({
      where: { relationId, toStatus: stage, createdAt: { lte: before } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  },
  createRun: async (run) => {
    try {
      return await prisma.automationRun.create({
        data: { ...run, results: run.results as unknown as Prisma.InputJsonValue, finishedAt: run.status === 'PENDING' ? null : run.runAt },
        select: { id: true },
      });
    } catch (e) {
      // (ruleId, eventId) already has its run: a redelivered event.
      if ((e as { code?: string })?.code === 'P2002') return null;
      throw e;
    }
  },
  loadRun: (runId) =>
    prisma.automationRun.findUnique({
      where: { id: runId },
      select: { id: true, orgId: true, ruleId: true, eventId: true, relationId: true, fromStage: true, toStage: true, status: true },
    }),
  claimRun: async (runId) => {
    const { count } = await prisma.automationRun.updateMany({ where: { id: runId, status: 'PENDING' }, data: { status: 'RUNNING' } });
    return count === 1;
  },
  finishRun: async (runId, outcome) => {
    await prisma.automationRun.updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: { status: outcome.status, results: outcome.results as unknown as Prisma.InputJsonValue, error: outcome.error, finishedAt: outcome.finishedAt },
    });
  },
  scheduleRun: async ({ id, orgId, runAt }) => {
    await enqueue('automation.run', { runId: id }, { orgId, runAt, idempotencyKey: `automation:${id}`, trigger: 'event' });
  },
  isOutcomeStage: isOutcomeStageFor,
  executeAction: executeAutomationAction,
};

/**
 * The `automation` subscriber's body (registered in
 * src/lib/events/subscribers/automation.ts). Rerun-safe: a redelivered event
 * finds its runs by (ruleId, eventId) and creates none; a run already claimed
 * is not run again.
 */
export async function evaluateAutomationEvent(event: DeliveredEvent): Promise<void> {
  if (!event.orgId) return;
  const orgId = event.orgId;
  await runWithOrg(orgId, () => evaluateStageEvent({ id: event.id, name: event.name, orgId, payload: event.payload }, prismaAutomationStore));
}

/** The `automation.run` job body: a delayed run's actions, once. */
export async function runDelayedAutomation(runId: string): Promise<{ ran: number }> {
  const run = await prisma.automationRun.findUnique({ where: { id: runId }, select: { orgId: true } });
  if (!run?.orgId) return { ran: 0 };
  const status = await runWithOrg(run.orgId, () => executeRun(runId, prismaAutomationStore));
  return { ran: status ? 1 : 0 };
}
