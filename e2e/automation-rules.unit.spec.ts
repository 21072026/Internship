// Stage automation rules (#1703) — pure node, no browser, no database.
// Run with BASE_URL=http://localhost:9.
//
// Pins the write-time gate (allowlist, no URL / address / free text, no mentee
// message on an outcome stage), the one condition evaluator, and the engine
// against an in-memory store: a rule fires, conditions exclude, a failing
// action leaves a PARTIAL run, another org's rule or relation is never acted
// on, a redelivered event makes no second run, a delay goes to the queue, and a
// burst of N moves makes N runs.
import { test, expect } from '@playwright/test';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_ACTION_TYPES,
  evaluateConditions,
  parseRuleInput,
  runStatusFor,
  type AutomationAction,
  type AutomationFacts,
} from '@/lib/automation/rule';
import {
  AUTOMATION_SUBSCRIBER,
  STAGE_CHANGE_EVENT,
  evaluateStageEvent,
  executeRun,
  type ActionContext,
  type AutomationStore,
  type NewRun,
  type RelationRow,
  type RuleRow,
} from '@/lib/automation/engine';
import { automationSubscriber } from '@/lib/events/subscribers/automation';
import { createSubscriberRegistry } from '@/lib/events/subscribers';

const notOutcome = () => false;

test.describe('parseRuleInput() — the write-time gate', () => {
  const base = { name: 'Interview prep', trigger: 'STAGE_ENTRY', stageKey: 'INTERVIEW_PENDING_250', actions: [{ type: 'notifyRole', role: 'mentor' }] };

  test('accepts an allowlisted rule and defaults it to disabled, no delay, no conditions', () => {
    const r = parseRuleInput(base, notOutcome);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule).toMatchObject({ enabled: false, delayMinutes: 0, conditions: [] });
  });

  test('rejects an unknown action name at write time', () => {
    const r = parseRuleInput({ ...base, actions: [{ type: 'callWebhook', url: 'https://evil.example' }] }, notOutcome);
    expect(r.ok).toBe(false);
  });

  test('no action accepts a URL, an address or free text — extra keys are refused', () => {
    for (const extra of [{ url: 'https://evil.example' }, { to: 'someone@example.test' }, { body: '{{process.env}}' }, { subject: 'x' }]) {
      for (const action of [{ type: 'notifyRole', role: 'mentor' }, { type: 'sendTemplateEmail', template: 'mentorCheckIn' }, { type: 'addTag', tagId: 't1' }]) {
        expect(parseRuleInput({ ...base, actions: [{ ...action, ...extra }] }, notOutcome).ok).toBe(false);
      }
    }
    // A template is a catalogue key, never a body.
    expect(parseRuleInput({ ...base, actions: [{ type: 'sendTemplateEmail', template: '<h1>hi</h1>' }] }, notOutcome).ok).toBe(false);
    // A recipient is a role, never an address.
    expect(parseRuleInput({ ...base, actions: [{ type: 'notifyRole', role: 'x@example.test' }] }, notOutcome).ok).toBe(false);
  });

  test('rejects an unknown condition field or operator', () => {
    expect(parseRuleInput({ ...base, conditions: [{ field: 'email', op: 'eq', value: 'a' }] }, notOutcome).ok).toBe(false);
    expect(parseRuleInput({ ...base, conditions: [{ field: 'kind', op: 'matches', value: 'PLACEMENT' }] }, notOutcome).ok).toBe(false);
  });

  test('refuses a mentee message on entry to an outcome stage, allows the mentor one', () => {
    const isOutcome = (k: string) => k === 'INTERNSHIP_DROPPED_460';
    const r = parseRuleInput({ ...base, stageKey: 'INTERNSHIP_DROPPED_460', actions: [{ type: 'sendTemplateEmail', template: 'menteeNextStep' }] }, isOutcome);
    expect(r).toMatchObject({ ok: false, code: 'mentee_message_on_outcome_stage' });
    expect(parseRuleInput({ ...base, stageKey: 'INTERNSHIP_DROPPED_460' }, isOutcome).ok).toBe(true);
  });

  test('no allowlisted action moves a stage (a rule cannot retrigger itself)', () => {
    for (const type of AUTOMATION_ACTION_TYPES) expect(AUTOMATION_ACTIONS[type].movesStage).toBe(false);
    expect(AUTOMATION_ACTION_TYPES).not.toContain('logInteraction');
  });
});

test.describe('evaluateConditions()', () => {
  const facts: AutomationFacts = { kind: 'PLACEMENT', hasCompany: true, fromStage: 'A', toStage: 'B', daysInFromStage: 4 };
  test('ANDs every condition and names the ones that failed', () => {
    expect(evaluateConditions([{ field: 'kind', op: 'eq', value: 'PLACEMENT' }, { field: 'daysInFromStage', op: 'gte', value: 3 }], facts)).toEqual({ pass: true, failed: [] });
    expect(evaluateConditions([{ field: 'hasCompany', op: 'eq', value: false }, { field: 'fromStage', op: 'in', value: ['A'] }, { field: 'toStage', op: 'notIn', value: ['B'] }], facts)).toEqual({
      pass: false,
      failed: ['hasCompany', 'toStage'],
    });
    expect(evaluateConditions([{ field: 'daysInFromStage', op: 'lte', value: 1 }], { ...facts, daysInFromStage: null }).pass).toBe(false);
  });
  test('run status folds per-action results', () => {
    expect(runStatusFor([{ index: 0, type: 'a', status: 'ok' }, { index: 1, type: 'b', status: 'skipped' }])).toBe('SUCCESS');
    expect(runStatusFor([{ index: 0, type: 'a', status: 'ok' }, { index: 1, type: 'b', status: 'failed' }])).toBe('PARTIAL');
    expect(runStatusFor([{ index: 0, type: 'a', status: 'failed' }])).toBe('FAILED');
  });
});

// ── The engine against an in-memory store ───────────────────────────────────

interface MemRun extends NewRun {
  id: string;
  finishedAt?: Date;
}

function memoryStore(opts: { rules: RuleRow[]; relations: RelationRow[]; failOn?: string; outcomeStages?: string[] }) {
  const runs: MemRun[] = [];
  const executed: { type: string; relationId: string; orgId: string }[] = [];
  const scheduled: { id: string; runAt: Date }[] = [];
  let seq = 0;
  const store: AutomationStore = {
    loadRules: async (orgId, keys) => opts.rules.filter((r) => r.orgId === orgId && r.enabled && keys.includes(r.stageKey)),
    loadRule: async (id) => opts.rules.find((r) => r.id === id) ?? null,
    loadRelation: async (id) => opts.relations.find((r) => r.id === id) ?? null,
    stageEnteredAt: async () => null,
    createRun: async (run) => {
      if (runs.some((r) => r.ruleId === run.ruleId && r.eventId === run.eventId)) return null;
      const row = { ...run, id: `run${++seq}` };
      runs.push(row);
      return { id: row.id };
    },
    loadRun: async (id) => runs.find((r) => r.id === id) ?? null,
    claimRun: async (id) => {
      const r = runs.find((x) => x.id === id);
      if (!r || r.status !== 'PENDING') return false;
      r.status = 'RUNNING';
      return true;
    },
    finishRun: async (id, outcome) => {
      Object.assign(runs.find((x) => x.id === id)!, outcome);
    },
    scheduleRun: async (run) => {
      scheduled.push({ id: run.id, runAt: run.runAt });
    },
    isOutcomeStage: async (_org, key) => (opts.outcomeStages ?? []).includes(key),
    executeAction: async (action: AutomationAction, ctx: ActionContext) => {
      if (action.type === opts.failOn) throw new Error('boom');
      executed.push({ type: action.type, relationId: ctx.relation.id, orgId: ctx.orgId });
      return { status: 'ok' };
    },
  };
  return { store, runs, executed, scheduled };
}

const rule = (over: Partial<RuleRow> = {}): RuleRow => ({
  id: 'rule1',
  orgId: 'orgA',
  name: 'Interview prep',
  trigger: 'STAGE_ENTRY',
  stageKey: 'INTERVIEW',
  conditions: [],
  actions: [{ type: 'notifyRole', role: 'mentor' }, { type: 'setStageDeadline', days: 5 }],
  delayMinutes: 0,
  enabled: true,
  ...over,
});
const relation = (over: Partial<RelationRow> = {}): RelationRow => ({
  id: 'rel1',
  orgId: 'orgA',
  kind: 'PLACEMENT',
  companyId: null,
  pipelineStatus: 'INTERVIEW',
  mentorId: 'm1',
  menteeId: 'e1',
  startDate: new Date('2026-10-01T00:00:00Z'),
  ...over,
});
const move = (over: { id?: string; orgId?: string | null; relationId?: string; from?: string; to?: string } = {}) => ({
  id: over.id ?? 'ev1',
  name: STAGE_CHANGE_EVENT,
  orgId: over.orgId === undefined ? 'orgA' : over.orgId,
  payload: { relationId: over.relationId ?? 'rel1', from: over.from ?? 'APPLIED', to: over.to ?? 'INTERVIEW' },
});

test.describe('evaluateStageEvent() / executeRun()', () => {
  test('the subscriber listens to pipeline.stage_change under a stable name', () => {
    const registry = createSubscriberRegistry();
    registry.register(automationSubscriber);
    expect(registry.interestedIn(STAGE_CHANGE_EVENT)).toEqual([AUTOMATION_SUBSCRIBER]);
  });

  test('a rule fires: actions run in order, one SUCCESS run', async () => {
    const m = memoryStore({ rules: [rule()], relations: [relation()] });
    const s = await evaluateStageEvent(move(), m.store);
    expect(s).toMatchObject({ matched: 1, executed: 1 });
    expect(m.executed.map((e) => e.type)).toEqual(['notifyRole', 'setStageDeadline']);
    expect(m.runs).toHaveLength(1);
    expect(m.runs[0]).toMatchObject({ status: 'SUCCESS', ruleId: 'rule1', eventId: 'ev1', fromStage: 'APPLIED', toStage: 'INTERVIEW' });
  });

  test('an exit rule fires on leaving its stage, not on entering it', async () => {
    const m = memoryStore({ rules: [rule({ trigger: 'STAGE_EXIT', stageKey: 'APPLIED' })], relations: [relation()] });
    await evaluateStageEvent(move(), m.store);
    expect(m.runs[0]?.status).toBe('SUCCESS');
    const n = memoryStore({ rules: [rule({ trigger: 'STAGE_EXIT' })], relations: [relation()] });
    await evaluateStageEvent(move(), n.store);
    expect(n.runs).toHaveLength(0);
  });

  test('conditions exclude: one SKIPPED run, no action', async () => {
    const m = memoryStore({ rules: [rule({ conditions: [{ field: 'hasCompany', op: 'eq', value: true }] })], relations: [relation()] });
    await evaluateStageEvent(move(), m.store);
    expect(m.executed).toHaveLength(0);
    expect(m.runs[0]).toMatchObject({ status: 'SKIPPED', error: 'conditions_not_met: hasCompany' });
  });

  test('a failing action records the error, the next action still runs, the run is PARTIAL', async () => {
    const m = memoryStore({ rules: [rule()], relations: [relation()], failOn: 'notifyRole' });
    await evaluateStageEvent(move(), m.store);
    expect(m.executed.map((e) => e.type)).toEqual(['setStageDeadline']);
    expect(m.runs[0]).toMatchObject({ status: 'PARTIAL', error: 'notifyRole: boom' });
    expect((m.runs[0].results as { status: string }[]).map((r) => r.status)).toEqual(['failed', 'ok']);
  });

  test("another org's rule or relation never fires", { tag: '@smoke' }, async () => {
    // A rule of org B for the same stage: the event is org A's.
    const m = memoryStore({ rules: [rule({ id: 'ruleB', orgId: 'orgB' })], relations: [relation()] });
    await evaluateStageEvent(move(), m.store);
    expect(m.runs).toHaveLength(0);
    // Even a store that leaks org B's rule into org A's load is filtered.
    const leaky = memoryStore({ rules: [rule({ id: 'ruleB', orgId: 'orgB' })], relations: [relation()] });
    leaky.store.loadRules = async () => [rule({ id: 'ruleB', orgId: 'orgB' })];
    await evaluateStageEvent(move(), leaky.store);
    expect(leaky.runs).toHaveLength(0);
    // Org A's rule, but the relation belongs to org B.
    const n = memoryStore({ rules: [rule()], relations: [relation({ orgId: 'orgB' })] });
    await evaluateStageEvent(move(), n.store);
    expect(n.runs).toHaveLength(0);
    // An event without a tenant runs nothing.
    const o = memoryStore({ rules: [rule()], relations: [relation()] });
    await evaluateStageEvent(move({ orgId: null }), o.store);
    expect(o.runs).toHaveLength(0);
  });

  test('a redelivered event makes no second run and runs no action twice', async () => {
    const m = memoryStore({ rules: [rule()], relations: [relation()] });
    await evaluateStageEvent(move(), m.store);
    const again = await evaluateStageEvent(move(), m.store);
    expect(again.duplicate).toBe(1);
    expect(m.runs).toHaveLength(1);
    expect(m.executed).toHaveLength(2);
    // And a claimed run is not run again.
    expect(await executeRun(m.runs[0].id, m.store)).toBeNull();
  });

  test('a delay goes to the queue; the delayed run skips once the relation left the stage', async () => {
    const now = new Date('2026-10-27T10:00:00Z');
    const m = memoryStore({ rules: [rule({ delayMinutes: 60 })], relations: [relation()] });
    const s = await evaluateStageEvent(move(), m.store, now);
    expect(s.scheduled).toBe(1);
    expect(m.executed).toHaveLength(0);
    expect(m.scheduled[0].runAt.toISOString()).toBe('2026-10-27T11:00:00.000Z');
    expect(m.runs[0].status).toBe('PENDING');
    expect(await executeRun(m.runs[0].id, m.store)).toBe('SUCCESS');

    const n = memoryStore({ rules: [rule({ delayMinutes: 60 })], relations: [relation()] });
    await evaluateStageEvent(move(), n.store, now);
    n.store.loadRelation = async () => relation({ pipelineStatus: 'OFFER' });
    expect(await executeRun(n.runs[0].id, n.store)).toBe('SKIPPED');
    expect(n.runs[0].error).toBe('left_stage');
    expect(n.executed).toHaveLength(0);
  });

  test('a rule switched off while its run waited does nothing', async () => {
    const rules = [rule({ delayMinutes: 5 })];
    const m = memoryStore({ rules, relations: [relation()] });
    await evaluateStageEvent(move(), m.store);
    rules[0].enabled = false;
    expect(await executeRun(m.runs[0].id, m.store)).toBe('SKIPPED');
    expect(m.runs[0].error).toBe('rule_disabled');
  });

  test('on an outcome stage a mentee-facing action is skipped, the mentor one still runs', async () => {
    const actions = [{ type: 'sendTemplateEmail', template: 'menteeNextStep' }, { type: 'notifyRole', role: 'mentor' }];
    const m = memoryStore({ rules: [rule({ stageKey: 'DROPPED', actions })], relations: [relation({ pipelineStatus: 'DROPPED' })], outcomeStages: ['DROPPED'] });
    await evaluateStageEvent(move({ to: 'DROPPED' }), m.store);
    expect(m.executed.map((e) => e.type)).toEqual(['notifyRole']);
    expect(m.runs[0].results).toEqual([
      { index: 0, type: 'sendTemplateEmail', status: 'skipped', detail: 'outcome_stage' },
      { index: 1, type: 'notifyRole', status: 'ok' },
    ]);
  });

  test('a stored rule that no longer parses records a FAILED run, never a guess', async () => {
    const m = memoryStore({ rules: [rule({ actions: [{ type: 'deleteEverything' }] })], relations: [relation()] });
    await evaluateStageEvent(move(), m.store);
    expect(m.runs[0]).toMatchObject({ status: 'FAILED', error: 'invalid_rule' });
    expect(m.executed).toHaveLength(0);
  });

  test('a bulk advance of N relations makes N runs', async () => {
    const relations = Array.from({ length: 12 }, (_, i) => relation({ id: `rel${i}` }));
    const m = memoryStore({ rules: [rule()], relations });
    for (const [i, r] of relations.entries()) await evaluateStageEvent(move({ id: `ev${i}`, relationId: r.id }), m.store);
    expect(m.runs).toHaveLength(12);
    expect(new Set(m.executed.map((e) => e.relationId)).size).toBe(12);
  });
});
