// First-contact auto-advance (#3746): the one decision, src/lib/firstContactAdvanceRule.ts.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideFirstContactAdvance,
  resolveFirstContactTarget,
  parseFirstContactMode,
  firstContactAdvanceApplies,
  FIRST_CONTACT_INTERACTION_TYPES,
  DEFAULT_FIRST_CONTACT_TARGET,
} from '../../src/lib/firstContactAdvanceRule.ts';
import { readFileSync } from 'node:fs';

const MARKETING_CAPS = ['companies', 'pipeline', 'messaging', 'documents', 'affiliate'];
const INTERNSHIP_CAPS = ['mentorship', 'evaluations', 'placements', 'sourcing', 'projects', 'companies', 'pipeline', 'messaging', 'documents'];
const FUNNEL = [
  { key: 'LEAD_NEW', order: 0, isTerminal: false, isOffPath: false },
  { key: 'LEAD_CONTACTED', order: 1, isTerminal: false, isOffPath: false },
  { key: 'LEAD_QUALIFIED', order: 2, isTerminal: false, isOffPath: false },
  { key: 'DEAL_WON', order: 5, isTerminal: true, isOffPath: false },
  { key: 'DEAL_LOST', order: 6, isTerminal: true, isOffPath: true },
];
const BASE = {
  caps: MARKETING_CAPS,
  mode: 'on',
  targetStage: '',
  interactionType: 'Call',
  relationActive: true,
  currentStage: 'LEAD_NEW',
  startKey: 'LEAD_NEW',
  stages: FUNNEL,
};

test('a call on a first-stage lead moves it to the preset "Contacted" stage', () => {
  assert.deepEqual(decideFirstContactAdvance(BASE), { move: true, from: 'LEAD_NEW', to: 'LEAD_CONTACTED' });
});

test('call, meeting and e-mail count; a note (Feedback) and WhatsApp do not', () => {
  assert.deepEqual([...FIRST_CONTACT_INTERACTION_TYPES], ['Call', 'Meeting', 'Email']);
  for (const type of ['Call', 'Meeting', 'Email']) assert.equal(decideFirstContactAdvance({ ...BASE, interactionType: type }).move, true, type);
  for (const type of ['Feedback', 'WhatsApp', 'Other']) {
    assert.deepEqual(decideFirstContactAdvance({ ...BASE, interactionType: type }), { move: false, reason: 'type' }, type);
  }
});

test('the switch is off by default, and anything but "on" is off', () => {
  for (const mode of [undefined, null, '', 'off', 'true', 'ON ', 'yes']) {
    const expected = typeof mode === 'string' && mode.trim() === 'on' ? 'on' : 'off';
    assert.equal(parseFirstContactMode(mode), expected, String(mode));
  }
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, mode: 'off' }), { move: false, reason: 'off' });
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, mode: '' }), { move: false, reason: 'off' });
});

test('settings.ts stores it off by default, with a blank target', () => {
  const src = readFileSync(new URL('../../src/lib/settings.ts', import.meta.url), 'utf8');
  assert.match(src, /^\s*firstContactAutoAdvance:\s*'off',/m);
  assert.match(src, /^\s*firstContactTargetStage:\s*'',/m);
});

test('INTERNSHIP never moves, even with the switch on', () => {
  assert.equal(firstContactAdvanceApplies(INTERNSHIP_CAPS), false);
  assert.equal(firstContactAdvanceApplies(MARKETING_CAPS), true);
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, caps: INTERNSHIP_CAPS }), { move: false, reason: 'vertical' });
});

test('only from the FIRST stage, and only an active relation', () => {
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, currentStage: 'LEAD_CONTACTED' }), { move: false, reason: 'not_first_stage' });
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, currentStage: 'LEAD_QUALIFIED' }), { move: false, reason: 'not_first_stage' });
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, currentStage: 'DEAL_LOST' }), { move: false, reason: 'not_first_stage' });
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, relationActive: false }), { move: false, reason: 'inactive' });
});

test('the target: the stored key, else the preset default — only on the path, after the start', () => {
  assert.equal(DEFAULT_FIRST_CONTACT_TARGET, 'LEAD_CONTACTED');
  assert.equal(resolveFirstContactTarget('', FUNNEL, 'LEAD_NEW'), 'LEAD_CONTACTED');
  assert.equal(resolveFirstContactTarget('LEAD_QUALIFIED', FUNNEL, 'LEAD_NEW'), 'LEAD_QUALIFIED');
  assert.equal(decideFirstContactAdvance({ ...BASE, targetStage: 'LEAD_QUALIFIED' }).to, 'LEAD_QUALIFIED');
  // Not in this pipeline, terminal, off-path, the start itself: no target → the rule does not run.
  for (const stored of ['NOT_A_STAGE', 'DEAL_WON', 'DEAL_LOST', 'LEAD_NEW']) {
    assert.equal(resolveFirstContactTarget(stored, FUNNEL, 'LEAD_NEW'), null, stored);
    assert.deepEqual(decideFirstContactAdvance({ ...BASE, targetStage: stored }), { move: false, reason: 'no_target' }, stored);
  }
  // A pipeline without the preset's stage and no stored target: nothing to move to.
  const custom = [
    { key: 'NEW', order: 0, isTerminal: false, isOffPath: false },
    { key: 'TALKING', order: 1, isTerminal: false, isOffPath: false },
  ];
  assert.deepEqual(decideFirstContactAdvance({ ...BASE, stages: custom, startKey: 'NEW', currentStage: 'NEW' }), { move: false, reason: 'no_target' });
  assert.deepEqual(
    decideFirstContactAdvance({ ...BASE, stages: custom, startKey: 'NEW', currentStage: 'NEW', targetStage: 'TALKING' }),
    { move: true, from: 'NEW', to: 'TALKING' },
  );
});
