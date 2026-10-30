// Programme eligibility (#1945) — the pure rule. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));

const { evaluateEligibility, effectiveMode, ruleMatches, orderRules, parseRuleInput, countAdmitted, isEligibilityAttribute } = await import(
  '../../src/lib/eligibilityRule.ts'
);

let seq = 0;
const rule = (effect, attribute, operator, value, priority = 0, extra = {}) => ({
  id: `r${++seq}`,
  effect,
  attribute,
  operator,
  value,
  priority,
  active: true,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
  ...extra,
});

test('OPEN admits everyone, whatever the rules; RULES is ineligible by default', () => {
  const rules = [rule('DENY', 'city', 'EQUALS', 'Berlin')];
  assert.deepEqual(evaluateEligibility('OPEN', rules, { city: 'Berlin' }), { ok: true, reason: 'open' });
  assert.deepEqual(evaluateEligibility('RULES', [], { city: 'Berlin' }), { ok: false, reason: 'no_matching_rule' });
  assert.equal(effectiveMode('OPEN', 'OPEN'), 'OPEN');
  assert.equal(effectiveMode('RULES', 'OPEN'), 'RULES');
  assert.equal(effectiveMode('OPEN', 'RULES'), 'RULES');
  assert.equal(effectiveMode(null, undefined), 'OPEN');
});

test('the precedence table: priority first, DENY beats ALLOW at equal priority, then age — deterministic', () => {
  const allowEng = rule('ALLOW', 'department', 'EQUALS', 'Engineering', 10);
  const denyBerlin = rule('DENY', 'city', 'EQUALS', 'Berlin', 10);
  const allowBerlinHigh = rule('ALLOW', 'city', 'EQUALS', 'Berlin', 20);
  const eng = { department: 'engineering ', city: 'Berlin' };

  // Equal priority: DENY wins, whatever the insertion order.
  for (const rules of [[allowEng, denyBerlin], [denyBerlin, allowEng]]) {
    assert.deepEqual(evaluateEligibility('RULES', rules, eng), { ok: false, reason: 'denied', ruleId: denyBerlin.id });
  }
  // A higher-priority ALLOW is an exception that beats the DENY.
  assert.deepEqual(evaluateEligibility('RULES', [allowEng, denyBerlin, allowBerlinHigh], eng), { ok: true, reason: 'allowed', ruleId: allowBerlinHigh.id });
  // A non-matching DENY decides nothing.
  assert.deepEqual(evaluateEligibility('RULES', [allowEng, denyBerlin], { department: 'Engineering', city: 'Köln' }), { ok: true, reason: 'allowed', ruleId: allowEng.id });
  // Same effect and priority: the older rule is named.
  const a = rule('ALLOW', 'city', 'IN', ['Köln'], 0);
  const b = rule('ALLOW', 'city', 'IN', ['köln'], 0);
  assert.equal(evaluateEligibility('RULES', [b, a], { city: 'KÖLN' }).ruleId, a.id);
  assert.deepEqual(orderRules([b, a]).map((r) => r.id), [a.id, b.id]);
  // An inactive rule is not there.
  const paused = rule('DENY', 'city', 'EQUALS', 'Köln', 100, { active: false });
  assert.equal(evaluateEligibility('RULES', [a, paused], { city: 'Köln' }).ok, true);
});

test('operators: EQUALS, IN, NOT_IN, GTE/LTE on numbers and ISO dates, EXISTS', () => {
  assert.equal(ruleMatches({ attribute: 'city', operator: 'IN', value: ['Istanbul', 'Berlin'] }, { city: ' berlin' }), true);
  assert.equal(ruleMatches({ attribute: 'city', operator: 'NOT_IN', value: ['Berlin'] }, { city: 'Köln' }), true);
  assert.equal(ruleMatches({ attribute: 'city', operator: 'NOT_IN', value: ['Berlin'] }, { city: null }), false, 'no value is not "none of"');
  assert.equal(ruleMatches({ attribute: 'attr:level', operator: 'GTE', value: '3' }, { 'attr:level': '4' }), true);
  assert.equal(ruleMatches({ attribute: 'attr:level', operator: 'GTE', value: '3' }, { 'attr:level': '10' }), true, 'numeric, not lexical');
  assert.equal(ruleMatches({ attribute: 'attr:level', operator: 'GTE', value: '3' }, { 'attr:level': 'senior' }), false);
  assert.equal(ruleMatches({ attribute: 'attr:start', operator: 'LTE', value: '2025-01-01' }, { 'attr:start': '2024-12-31' }), true);
  assert.equal(ruleMatches({ attribute: 'city', operator: 'EXISTS', value: true }, { city: '  ' }), false);
  assert.equal(ruleMatches({ attribute: 'city', operator: 'EXISTS', value: false }, {}), true);
  assert.equal(ruleMatches({ attribute: 'city', operator: 'REGEX', value: '.*' }, { city: 'x' }), false, 'unknown operator admits nobody');
});

test('the write gate stores only what the evaluator reads', () => {
  assert.equal(isEligibilityAttribute('department'), true);
  assert.equal(isEligibilityAttribute('attr:level'), true);
  for (const bad of ['email', 'role', 'orgId', 'password', 'attr:', 'attr:Bad']) assert.equal(isEligibilityAttribute(bad), false, bad);
  assert.deepEqual(parseRuleInput({ effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ' Berlin , ,berlin', priority: 5 }), {
    ok: true,
    rule: { effect: 'ALLOW', attribute: 'city', operator: 'IN', value: ['Berlin'], priority: 5 },
  });
  assert.equal(parseRuleInput({ effect: 'MAYBE', attribute: 'city', operator: 'IN', value: ['x'] }).code, 'invalid_effect');
  assert.equal(parseRuleInput({ effect: 'ALLOW', attribute: 'email', operator: 'IN', value: ['x'] }).code, 'invalid_attribute');
  assert.equal(parseRuleInput({ effect: 'ALLOW', attribute: 'city', operator: 'IN', value: [] }).code, 'invalid_value');
  assert.equal(parseRuleInput({ effect: 'ALLOW', attribute: 'city', operator: 'GTE', value: 'abc' }).code, 'invalid_value');
  assert.equal(parseRuleInput({ effect: 'ALLOW', attribute: 'city', operator: 'EXISTS', value: 'yes' }).code, 'invalid_value');
  assert.equal(parseRuleInput({ effect: 'ALLOW', attribute: 'city', operator: 'EQUALS', value: 'x', priority: 1.5 }).code, 'invalid_priority');
});

test('the dry-run count is the evaluator over the roster', () => {
  const rules = [rule('ALLOW', 'department', 'EQUALS', 'Engineering'), rule('DENY', 'city', 'EQUALS', 'Paris')];
  const roster = [
    { department: 'Engineering', city: 'Berlin' },
    { department: 'Engineering', city: 'Paris' },
    { department: 'Sales', city: 'Berlin' },
  ];
  assert.equal(countAdmitted('RULES', rules, roster), 1);
  assert.equal(countAdmitted('OPEN', rules, roster), 3);
});
