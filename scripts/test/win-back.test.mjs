// Unit tests for src/lib/winBackRule.ts — a lost customer coming back (#2842).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWinBack, WIN_BACK_STAGES } from '../../src/lib/winBackRule.ts';

const STAGES = ['LEAD_NEW', 'TRIAL_ACTIVE', 'TRIAL_EXPIRED', 'DEAL_WON', 'DEAL_LOST'];
const lost = { status: 'ACTIVE', pipelineStatus: 'DEAL_LOST' };

test('a lost record comes back into a new trial or signed', () => {
  assert.deepEqual([...WIN_BACK_STAGES], ['TRIAL_ACTIVE', 'DEAL_WON']);
  assert.deepEqual(planWinBack({ relation: lost, toStage: 'TRIAL_ACTIVE', stageKeys: STAGES }), { ok: true, toStage: 'TRIAL_ACTIVE' });
  assert.deepEqual(planWinBack({ relation: lost, toStage: 'DEAL_WON', stageKeys: STAGES }), { ok: true, toStage: 'DEAL_WON' });
});

test('only an open, lost record; only the two entry stages; only stages the org has', () => {
  assert.deepEqual(planWinBack({ relation: { ...lost, pipelineStatus: 'DEAL_WON' }, toStage: 'DEAL_WON', stageKeys: STAGES }), { ok: false, error: 'not_lost' });
  assert.deepEqual(planWinBack({ relation: { ...lost, status: 'COMPLETED' }, toStage: 'DEAL_WON', stageKeys: STAGES }), { ok: false, error: 'closed' });
  assert.deepEqual(planWinBack({ relation: lost, toStage: 'LEAD_NEW', stageKeys: STAGES }), { ok: false, error: 'bad_stage' });
  assert.deepEqual(planWinBack({ relation: lost, toStage: 'TRIAL_ACTIVE', stageKeys: ['DEAL_WON', 'DEAL_LOST'] }), { ok: false, error: 'stage_missing' });
});
