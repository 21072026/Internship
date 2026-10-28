// The /admin/automations dry run (#1704) — pure node, no browser, no database.
// Run with BASE_URL=http://localhost:9.
//
// Pins that the simulation is structurally incapable of executing an action
// (its module graph reaches the rule vocabulary and nothing else) and that its
// verdicts are the live engine's: trigger match, conditions, outcome-stage skip.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simulateRule, type HistoryMove } from '@/lib/automation/simulate';
import type { AutomationAction } from '@/lib/automation/rule';

const ROOT = join(__dirname, '..');

function importsOf(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8');
  return [...src.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

test.describe('simulate: executes nothing, by construction', () => {
  test('simulate.ts imports only the rule vocabulary', { tag: '@smoke' }, () => {
    expect(importsOf('src/lib/automation/simulate.ts')).toEqual(['./rule']);
    // …and the vocabulary itself imports only zod.
    expect(importsOf('src/lib/automation/rule.ts')).toEqual(['zod']);
  });

  test('the simulate route never imports the engine, an action handler, a mailer or notify', () => {
    const imports = importsOf('src/app/api/admin/automations/[id]/simulate/route.ts').concat(importsOf('src/lib/automation/admin.ts'));
    for (const banned of ['@/lib/automation/engine', '@/lib/automation/actions', '@/lib/automation/evaluate', '@/services/emailService', '@/lib/notify', './engine', './actions', './evaluate']) {
      expect(imports).not.toContain(banned);
    }
  });
});

const at = (iso: string) => new Date(iso);
const move = (over: Partial<HistoryMove>): HistoryMove => ({
  id: 'sc1',
  relationId: 'rel1',
  from: 'APPLIED',
  to: 'INTERVIEW',
  at: at('2026-10-20T10:00:00Z'),
  kind: 'PLACEMENT',
  hasCompany: false,
  relationStart: at('2026-10-01T10:00:00Z'),
  menteeName: 'Synthetic Person',
  ...over,
});
const actions: AutomationAction[] = [{ type: 'notifyRole', role: 'mentor' }, { type: 'sendTemplateEmail', template: 'menteeNextStep' }];

test.describe('simulateRule()', () => {
  test('returns only the moves the trigger matches, with fire / skip verdicts', () => {
    const rule = { trigger: 'STAGE_ENTRY', stageKey: 'INTERVIEW', conditions: [{ field: 'hasCompany' as const, op: 'eq' as const, value: true }], actions };
    const history = [move({ id: 'a', hasCompany: true }), move({ id: 'b' }), move({ id: 'c', to: 'OFFER', from: 'INTERVIEW' })];
    const r = simulateRule(rule, history, new Map(), () => false);
    expect(r).toMatchObject({ considered: 3, matched: 2, wouldFire: 1 });
    expect(r.moves.map((m) => [m.moveId, m.verdict, m.failed])).toEqual([
      ['a', 'fire', []],
      ['b', 'skip', ['hasCompany']],
    ]);
    expect(r.moves[0].actions.map((a) => a.outcome)).toEqual(['would_run', 'would_run']);
    expect(r.moves[1].actions).toEqual([]);
  });

  test('daysInFromStage reads the entry into the from-stage before the move', () => {
    const rule = { trigger: 'STAGE_ENTRY', stageKey: 'INTERVIEW', conditions: [{ field: 'daysInFromStage' as const, op: 'gte' as const, value: 5 }], actions };
    const entries = new Map([['rel1', [{ stage: 'APPLIED', at: at('2026-10-18T10:00:00Z') }, { stage: 'APPLIED', at: at('2026-10-01T10:00:00Z') }]]]);
    // Latest entry before the move is the 18th → 2 days → skip.
    expect(simulateRule(rule, [move({})], entries, () => false).moves[0].verdict).toBe('skip');
    // No recorded entry → the relation's start (19 days) → fire.
    expect(simulateRule(rule, [move({})], new Map(), () => false).moves[0].verdict).toBe('fire');
  });

  test('an outcome stage marks the mentee-facing action as skipped, like the live run', () => {
    const rule = { trigger: 'STAGE_ENTRY', stageKey: 'DROPPED', conditions: [], actions };
    const r = simulateRule(rule, [move({ to: 'DROPPED' })], new Map(), (k) => k === 'DROPPED');
    expect(r.moves[0].actions.map((a) => a.outcome)).toEqual(['would_run', 'skipped_outcome_stage']);
  });
});
