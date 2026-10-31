import { test, expect } from '@playwright/test';
import { evaluateDimension, isAttributeDimension, type MatchMentee, type MatchMentor } from '@/lib/matching/dimensions';
import { scoreMatch, rankMatches } from '@/lib/matching/score';
import { loadAttributeValues, unknownAttributes, type AttributeValueDb } from '@/lib/matching/attributeValues';
import { matchRuleSchema } from '@/lib/matching/ruleSetSchema';

// #3424 — org attributes (UserAttributeValue) as matching dimensions. Browserless.

const ctx = { now: new Date('2026-10-31T12:00:00Z') };
const mentee = (attributes: Record<string, string>): MatchMentee => ({ id: 'me', attributes });
const mentor = (id: string, attributes: Record<string, string>): MatchMentor => ({ id, activeMenteeCount: 0, attributes });
const ev = (key: string, a: string | undefined, b: string | undefined, attributeMode?: string) =>
  evaluateDimension(`attribute:${key}`, mentee(a === undefined ? {} : { [key]: a }), mentor('m', b === undefined ? {} : { [key]: b }), attributeMode ? { attributeMode } : {}, ctx);

test('attribute:<key> compares same / different / mentor ≥ mentee; a missing value is neutral', { tag: '@smoke' }, () => {
  expect(isAttributeDimension('attribute:site')).toBe(true);
  expect(isAttributeDimension('attribute:Bad Key')).toBe(false);

  expect(ev('site', 'Berlin', 'berlin ')).toMatchObject({ matched: true, ratio: 1 });
  expect(ev('site', 'Berlin', 'Köln')).toMatchObject({ matched: false, ratio: 0 });
  expect(ev('bu', 'Sales', 'R&D', 'different')).toMatchObject({ matched: true, ratio: 1 });
  expect(ev('bu', 'Sales', 'sales', 'different')).toMatchObject({ matched: false, ratio: 0 });
  expect(ev('level', '3', '5', 'gte_mentor')).toMatchObject({ matched: true, ratio: 1 });
  expect(ev('level', '3', '3', 'gte_mentor')).toMatchObject({ matched: true });
  expect(ev('level', '4', '2', 'gte_mentor')).toMatchObject({ matched: false, ratio: 0 });
  // Not a number on either side under gte_mentor: not applicable, not a fail.
  expect(ev('level', 'senior', '5', 'gte_mentor')).toMatchObject({ applicable: false, ratio: 0 });
  // A value missing on either side — or an attribute deleted since — is neutral.
  expect(ev('site', 'Berlin', undefined)).toMatchObject({ applicable: false, ratio: 0 });
  expect(ev('site', undefined, 'Berlin')).toMatchObject({ applicable: false, ratio: 0 });
  // An unknown mode reads as `same`, never a crash.
  expect(ev('site', 'Berlin', 'Berlin', 'sideways')).toMatchObject({ matched: true });

  expect(matchRuleSchema.safeParse({ dimension: 'attribute:site', kind: 'WEIGHTED', weight: 40, config: { attributeMode: 'different' } }).success).toBe(true);
  expect(matchRuleSchema.safeParse({ dimension: 'attribute:site', kind: 'WEIGHTED', weight: 40, config: { attributeMode: 'sideways' } }).success).toBe(false);
  expect(matchRuleSchema.safeParse({ dimension: 'attribute:DROP TABLE', kind: 'WEIGHTED', weight: 40 }).success).toBe(false);
});

test('a weighted attribute flips the ranking deterministically; a missing value never penalises', { tag: '@smoke' }, () => {
  const me = mentee({ site: 'Berlin' });
  const away = mentor('away', { site: 'Köln' });
  const near = mentor('near', { site: 'Berlin' });
  const unknown = mentor('unknown', {});
  const rules = { id: null, name: 'r', version: 1, rules: [{ dimension: 'attribute:site', kind: 'WEIGHTED' as const, weight: 100, config: {} }] };
  expect(rankMatches(me, [away, unknown, near], rules, ctx).map((r) => r.mentor.id)).toEqual(['near', 'away', 'unknown']);
  expect(scoreMatch(me, unknown, rules, ctx).blockedBy).toEqual([]);
  const flipped = { ...rules, rules: [{ ...rules.rules[0], config: { attributeMode: 'different' } }] };
  expect(rankMatches(me, [near, away], flipped, ctx).map((r) => r.mentor.id)).toEqual(['away', 'near']);
  // A hard rule over a missing value passes (not applicable), so nobody is blocked by missing data.
  const hard = { ...rules, rules: [{ dimension: 'attribute:site', kind: 'HARD_REQUIRE' as const, weight: 0, config: {} }] };
  expect(scoreMatch(me, unknown, hard, ctx).blockedBy).toEqual([]);
  expect(scoreMatch(me, away, hard, ctx).blockedBy).toEqual(['attribute:site']);
});

test('values load in bulk: one query per side for a 200 × 40 pass; unknown keys are refused at the save', { tag: '@smoke' }, async () => {
  const calls = { values: 0, attrs: 0 };
  const db: AttributeValueDb = {
    userAttributeValue: {
      findMany: async (args: object) => {
        calls.values++;
        const where = (args as { where: { AND?: [{ userId: { in: string[] } }]; userId?: { in: string[] } } }).where;
        const ids = (where.AND?.[0] ?? where).userId!.in;
        return ids.map((userId, i) => ({ userId, value: i % 2 ? 'Berlin' : 'Köln', attribute: { key: 'site' } }));
      },
    },
    orgAttribute: { findMany: async () => (calls.attrs++, [{ key: 'site', type: 'SELECT', labelEn: 'Site', labelTr: 'Lokasyon', labelDe: 'Standort' }]) },
  };
  const tenant = { orgId: 'org1' };
  const [mentees, mentors] = await Promise.all([
    loadAttributeValues(db, tenant, Array.from({ length: 200 }, (_, i) => `mentee${i}`)),
    loadAttributeValues(db, tenant, Array.from({ length: 40 }, (_, i) => `mentor${i}`)),
  ]);
  expect(mentees.size).toBe(200);
  expect(mentors.get('mentor1')).toEqual({ site: 'Berlin' });
  expect(calls.values).toBe(2);
  expect(await loadAttributeValues(db, tenant, [])).toEqual(new Map());
  expect(calls.values).toBe(2);

  // The default org's tenant admits `orgId: null` (legacy users); attribute
  // rows always carry an org, so the query names the concrete one — a null
  // comparison on a required column is a Prisma validation error.
  let seen: unknown;
  const strict: AttributeValueDb = { ...db, userAttributeValue: { findMany: async (args: object) => ((seen = (args as { where: unknown }).where), []) } };
  await loadAttributeValues(strict, { OR: [{ orgId: 'default' }, { orgId: null }] }, ['u1']);
  expect(JSON.stringify(seen)).not.toContain('null');
  expect(JSON.stringify(seen)).toContain('"orgId":"default"');

  expect(await unknownAttributes(db, tenant, ['skills', 'attribute:site', 'attribute:gone'])).toEqual(['attribute:gone']);
  expect(await unknownAttributes(db, tenant, ['skills'])).toEqual([]);
  expect(calls.attrs).toBe(1);
});
