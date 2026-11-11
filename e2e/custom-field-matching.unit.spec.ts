import { test, expect } from '@playwright/test';
import { evaluateDimension, isCustomFieldDimension, type MatchMentee, type MatchMentor } from '@/lib/matching/dimensions';
import { scoreMatch } from '@/lib/matching/score';
import { foldAnswers, loadCustomAnswers, unmatchableCustomFields, type CustomAnswerDb } from '@/lib/matching/customAnswers';
import { matchRuleSchema } from '@/lib/matching/ruleSetSchema';

// #1803 — admin-defined questions as matching dimensions. Browserless.

const ctx = { now: new Date('2026-10-30T12:00:00Z') };
const mentee = (customAnswers: Record<string, unknown>): MatchMentee => ({ id: 'me', customAnswers });
const mentor = (id: string, customAnswers: Record<string, unknown>): MatchMentor => ({ id, activeMenteeCount: 0, customAnswers });

test('customField:<key> compares by the answer shape: exact, overlap, closeness', { tag: '@smoke' }, async () => {
  expect(isCustomFieldDimension('customField:industry')).toBe(true);
  expect(isCustomFieldDimension('customField:Bad Key')).toBe(false);
  const ev = (key: string, a: unknown, b: unknown, config = {}) => evaluateDimension(`customField:${key}`, mentee({ [key]: a }), mentor('m', { [key]: b }), config, ctx);

  expect(ev('industry', 'fin', 'fin')).toMatchObject({ matched: true, ratio: 1 });
  expect(ev('industry', 'fin', 'health')).toMatchObject({ matched: false, ratio: 0 });
  expect(ev('remote', true, false)).toMatchObject({ matched: false, ratio: 0 });
  expect(ev('tracks', ['web', 'data'], ['data', 'ops'])).toMatchObject({ matched: true, ratio: 0.5, detail: ['data'] });
  expect(ev('level', 3, 3)).toMatchObject({ matched: true, ratio: 1 });
  expect(ev('level', 3, 4)).toMatchObject({ matched: false, ratio: 0 });
  expect(ev('level', 3, 4, { tolerance: 1 })).toMatchObject({ matched: true, ratio: 0.5 });
  // Unanswered on either side: not applicable — the same 0 for every mentor.
  expect(ev('industry', 'fin', undefined)).toMatchObject({ matched: false, ratio: 0, applicable: false });

  // The rule schema takes the family; a malformed key is refused at the write.
  expect(matchRuleSchema.safeParse({ dimension: 'customField:industry', kind: 'WEIGHTED', weight: 50, config: { tolerance: 2 } }).success).toBe(true);
  expect(matchRuleSchema.safeParse({ dimension: 'customField:DROP TABLE', kind: 'WEIGHTED', weight: 50 }).success).toBe(false);
});

test('a weighted custom field reorders the ranking', { tag: '@smoke' }, async () => {
  const me = mentee({ industry: 'health' });
  const a = mentor('a', { industry: 'fin' });
  const b = mentor('b', { industry: 'health' });
  const rules = { id: null, name: 'r', version: 1, rules: [{ dimension: 'customField:industry', kind: 'WEIGHTED' as const, weight: 100, config: {} }] };
  const [sa, sb] = [scoreMatch(me, a, rules, ctx), scoreMatch(me, b, rules, ctx)];
  expect(sb.score).toBeGreaterThan(sa.score);
});

test('answers load in bulk: two queries for a 200 × 40 pass, never one per pair', { tag: '@smoke' }, async () => {
  const calls = { field: 0, response: 0 };
  const menteeIds = Array.from({ length: 200 }, (_, i) => `mentee${i}`);
  const mentorIds = Array.from({ length: 40 }, (_, i) => `mentor${i}`);
  const t0 = new Date('2026-10-01T00:00:00Z');
  const db: CustomAnswerDb = {
    formField: { findMany: async () => (calls.field++, [{ key: 'industry', type: 'SELECT', labels: { en: 'Industry' } }]) },
    formResponse: {
      findMany: async (args: object) => {
        calls.response++;
        const ids = (args as { where: { AND?: [{ userId: { in: string[] } }]; userId?: { in: string[] } } }).where;
        const userIds = (ids.AND?.[0] ?? ids).userId!.in;
        return userIds.map((userId, i) => ({ userId, fieldKey: 'industry', value: i % 2 ? 'fin' : 'health', updatedAt: t0 }));
      },
    },
  };
  const tenant = { orgId: 'org1' };
  const [mentees, mentors] = await Promise.all([loadCustomAnswers(db, tenant, menteeIds), loadCustomAnswers(db, tenant, mentorIds)]);
  expect(mentees.size).toBe(200);
  expect(mentors.size).toBe(40);
  // Scoring every pair touches no database at all.
  const rules = { id: null, name: 'r', version: 1, rules: [{ dimension: 'customField:industry', kind: 'WEIGHTED' as const, weight: 100, config: {} }] };
  for (const me of menteeIds) for (const mo of mentorIds) scoreMatch({ id: me, customAnswers: mentees.get(me) }, { id: mo, activeMenteeCount: 0, customAnswers: mentors.get(mo) }, rules, ctx);
  expect(calls).toEqual({ field: 2, response: 2 });
});

test('the newest answer wins; a rule naming a non-matchable question is refused', { tag: '@smoke' }, async () => {
  const older = new Date('2026-01-01T00:00:00Z');
  const newer = new Date('2026-06-01T00:00:00Z');
  const folded = foldAnswers([
    { userId: 'u', fieldKey: 'industry', value: 'fin', updatedAt: newer },
    { userId: 'u', fieldKey: 'industry', value: 'health', updatedAt: older },
  ]);
  expect(folded.get('u')).toEqual({ industry: 'fin' });

  const db: CustomAnswerDb = {
    formField: { findMany: async () => [{ key: 'industry', type: 'SELECT', labels: {} }] },
    formResponse: { findMany: async () => [] },
  };
  expect(await unmatchableCustomFields(db, { orgId: 'o' }, ['skills', 'customField:industry', 'customField:bio'])).toEqual(['customField:bio']);
});
