// The stage-automation engine (#1703) — the orchestration, with its storage
// injected. No Prisma import here: `./evaluate.ts` binds it to the database and
// `e2e/automation-rules.unit.spec.ts` to an in-memory store.
//
// TWO STEPS, BOTH ON THE QUEUE
//   1. `evaluateStageEvent()` runs as the `automation` subscriber of
//      `pipeline.stage_change` (an `event.deliver` job, never inside the request
//      that moved the stage — a bulk advance of N relations is N events, N jobs,
//      N runs, and the request returns before any of them). It loads the org's
//      ENABLED rules for the two stages of the move, judges each one's
//      conditions and records exactly one `AutomationRun` per (rule, event):
//      SKIPPED with the failed fields, or PENDING.
//   2. `executeRun()` claims a PENDING run (one guarded update: PENDING →
//      RUNNING, so two workers cannot both run it) and executes its actions in
//      order. A rule without a delay is executed right there in step 1; one with
//      a delay is handed to the `automation.run` job with `runAt` = now + delay.
//
// RE-ENTRANCY
//   `AutomationRun` is unique on (ruleId, eventId): a redelivered event (the
//   at-least-once contract of docs/job-worker.md) finds its run and does
//   nothing. No allowlisted action moves a stage (rule.ts), so an action cannot
//   raise another `pipeline.stage_change` — a rule cannot retrigger itself or
//   start a chain.
//
// AT-MOST-ONCE ACTIONS
//   The claim makes a run's actions at-most-once: a container killed mid-run
//   leaves the row RUNNING (visible in the run log) rather than mailing a
//   mentee twice. That is the right side to fail on for messages to people.
//
// FAILURE SEMANTICS
//   An action that throws is recorded `failed` with its message and the next
//   action still runs; the run ends PARTIAL or FAILED. Nothing here touches the
//   stage move — it was committed before the event existed.
//
// TENANCY
//   Rules are loaded by the event's own `orgId`, and every row is re-checked
//   against it (a rule or a relation of another org is never acted on, even if
//   a store returned one).

import {
  addressesMentee,
  evaluateConditions,
  readStoredRule,
  ruleMatchesMove,
  runStatusFor,
  wholeDaysBetween,
  type ActionResult,
  type AutomationAction,
  type AutomationFacts,
  type AutomationRunStatus,
} from './rule';

export const AUTOMATION_SUBSCRIBER = 'automation';
export const STAGE_CHANGE_EVENT = 'pipeline.stage_change';

export interface RuleRow {
  id: string;
  orgId: string | null;
  name: string;
  trigger: string;
  stageKey: string;
  conditions: unknown;
  actions: unknown;
  delayMinutes: number;
  enabled: boolean;
}

export interface RelationRow {
  id: string;
  orgId: string | null;
  kind: string;
  companyId: string | null;
  pipelineStatus: string;
  mentorId: string;
  menteeId: string;
  startDate: Date;
}

export interface RunRow {
  id: string;
  orgId: string | null;
  ruleId: string;
  eventId: string;
  relationId: string;
  fromStage: string;
  toStage: string;
  status: string;
}

export interface NewRun {
  orgId: string;
  ruleId: string;
  eventId: string;
  relationId: string;
  fromStage: string;
  toStage: string;
  status: AutomationRunStatus;
  results: ActionResult[];
  error: string | null;
  runAt: Date;
}

/** What one action needs to know. Ids only; the executor reads the rest itself. */
export interface ActionContext {
  orgId: string;
  runId: string;
  index: number;
  relation: RelationRow;
  ruleName: string;
  fromStage: string;
  toStage: string;
  now: Date;
}

export interface AutomationStore {
  /** ENABLED rules of `orgId` whose stageKey is one of `stageKeys`. */
  loadRules(orgId: string, stageKeys: string[]): Promise<RuleRow[]>;
  loadRule(ruleId: string): Promise<RuleRow | null>;
  loadRelation(relationId: string): Promise<RelationRow | null>;
  /** When the relation last entered `stage` before `before`; null when unknown. */
  stageEnteredAt(relationId: string, stage: string, before: Date): Promise<Date | null>;
  /** Insert a run; null when (ruleId, eventId) already has one. */
  createRun(run: NewRun): Promise<{ id: string } | null>;
  loadRun(runId: string): Promise<RunRow | null>;
  /** PENDING → RUNNING in one guarded update; false when someone else has it. */
  claimRun(runId: string): Promise<boolean>;
  finishRun(runId: string, outcome: { status: AutomationRunStatus; results: ActionResult[]; error: string | null; finishedAt: Date }): Promise<void>;
  /** Put a delayed run on the queue (`automation.run`, keyed by the run id). */
  scheduleRun(run: { id: string; orgId: string; runAt: Date }): Promise<void>;
  /** An ending (outcome / off-path) stage of this org? */
  isOutcomeStage(orgId: string, stageKey: string): Promise<boolean>;
  /** Execute one allowlisted action. Throw to record it as failed. */
  executeAction(action: AutomationAction, ctx: ActionContext): Promise<{ status: 'ok' | 'skipped'; detail?: string }>;
}

export interface StageEvent {
  id: string;
  name: string;
  orgId: string | null;
  payload: Record<string, unknown>;
}

export interface EvaluateSummary {
  matched: number;
  skipped: number;
  executed: number;
  scheduled: number;
  duplicate: number;
}

const ERROR_MAX = 1000;

function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.slice(0, ERROR_MAX);
}

/** Step 1 — the subscriber. Never throws for one bad rule; the others still run. */
export async function evaluateStageEvent(event: StageEvent, store: AutomationStore, now: Date = new Date()): Promise<EvaluateSummary> {
  const summary: EvaluateSummary = { matched: 0, skipped: 0, executed: 0, scheduled: 0, duplicate: 0 };
  if (event.name !== STAGE_CHANGE_EVENT || !event.orgId) return summary;
  const orgId = event.orgId;
  const relationId = typeof event.payload.relationId === 'string' ? event.payload.relationId : null;
  const from = typeof event.payload.from === 'string' ? event.payload.from : null;
  const to = typeof event.payload.to === 'string' ? event.payload.to : null;
  if (!relationId || !from || !to || from === to) return summary;

  const rules = (await store.loadRules(orgId, [from, to])).filter((r) => r.orgId === orgId && r.enabled && ruleMatchesMove(r, { from, to }));
  if (rules.length === 0) return summary;

  const relation = await store.loadRelation(relationId);
  if (!relation || relation.orgId !== orgId) return summary;

  let facts: AutomationFacts | null = null;
  const factsFor = async (): Promise<AutomationFacts> => {
    if (facts) return facts;
    const enteredFrom = await store.stageEnteredAt(relationId, from, now);
    facts = {
      kind: relation.kind,
      hasCompany: Boolean(relation.companyId),
      fromStage: from,
      toStage: to,
      daysInFromStage: wholeDaysBetween(enteredFrom ?? relation.startDate, now),
    };
    return facts;
  };

  for (const rule of rules) {
    summary.matched++;
    const base = { orgId, ruleId: rule.id, eventId: event.id, relationId, fromStage: from, toStage: to, results: [] as ActionResult[] };
    const stored = readStoredRule(rule);
    if (!stored) {
      const created = await store.createRun({ ...base, status: 'FAILED', error: 'invalid_rule', runAt: now });
      if (!created) summary.duplicate++;
      continue;
    }
    const verdict = evaluateConditions(stored.conditions, await factsFor());
    if (!verdict.pass) {
      const created = await store.createRun({ ...base, status: 'SKIPPED', error: `conditions_not_met: ${verdict.failed.join(', ')}`, runAt: now });
      if (created) summary.skipped++;
      else summary.duplicate++;
      continue;
    }
    const runAt = new Date(now.getTime() + Math.max(0, rule.delayMinutes) * 60_000);
    const created = await store.createRun({ ...base, status: 'PENDING', error: null, runAt });
    if (!created) {
      summary.duplicate++;
      continue;
    }
    if (rule.delayMinutes > 0) {
      await store.scheduleRun({ id: created.id, orgId, runAt });
      summary.scheduled++;
    } else {
      await executeRun(created.id, store, now);
      summary.executed++;
    }
  }
  return summary;
}

/** Step 2 — run one PENDING run's actions in order. Returns the final status, or null when not claimed. */
export async function executeRun(runId: string, store: AutomationStore, now: Date = new Date()): Promise<AutomationRunStatus | null> {
  if (!(await store.claimRun(runId))) return null;
  const run = await store.loadRun(runId);
  if (!run || !run.orgId) return null;
  const finish = async (status: AutomationRunStatus, results: ActionResult[], error: string | null) => {
    await store.finishRun(runId, { status, results, error, finishedAt: new Date() });
    return status;
  };

  const rule = await store.loadRule(run.ruleId);
  // Switched off (or deleted) while a delayed run waited: the admin's latest word wins.
  if (!rule || rule.orgId !== run.orgId || !rule.enabled) return finish('SKIPPED', [], 'rule_disabled');
  const relation = await store.loadRelation(run.relationId);
  if (!relation || relation.orgId !== run.orgId) return finish('SKIPPED', [], 'relation_gone');
  // "An hour after entering X, …" means nothing once the relation has left X.
  if (rule.trigger === 'STAGE_ENTRY' && relation.pipelineStatus !== rule.stageKey) return finish('SKIPPED', [], 'left_stage');
  const stored = readStoredRule(rule);
  if (!stored) return finish('FAILED', [], 'invalid_rule');

  // The stage the relation is in now. On an outcome stage the mentee hears from
  // their mentor, never from a rule (outcomeComms.ts, #830/#1684).
  const outcome = await store.isOutcomeStage(run.orgId, relation.pipelineStatus);
  const results: ActionResult[] = [];
  let firstError: string | null = null;
  for (const [index, action] of stored.actions.entries()) {
    if (outcome && addressesMentee(action)) {
      results.push({ index, type: action.type, status: 'skipped', detail: 'outcome_stage' });
      continue;
    }
    try {
      const out = await store.executeAction(action, {
        orgId: run.orgId,
        runId,
        index,
        relation,
        ruleName: rule.name,
        fromStage: run.fromStage,
        toStage: run.toStage,
        now,
      });
      results.push({ index, type: action.type, status: out.status, ...(out.detail ? { detail: out.detail } : {}) });
    } catch (e) {
      const text = errorText(e);
      firstError ??= `${action.type}: ${text}`;
      results.push({ index, type: action.type, status: 'failed', detail: text.slice(0, 200) });
    }
  }
  return finish(runStatusFor(results), results, firstError);
}
