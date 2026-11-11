import { test, expect } from '@playwright/test';
import { audienceWhere, isValidAudienceInput, parseAudience } from '../src/lib/announcementAudience';

// The announcement audience rule (#1721) — criteria in, a User where-clause out.
// No browser, no database.

test('no criteria means everyone; unknown keys and empty lists are dropped', { tag: '@smoke' }, () => {
  expect(parseAudience(undefined)).toBeNull();
  expect(parseAudience({})).toBeNull();
  expect(parseAudience({ roles: [] })).toBeNull();
  expect(parseAudience({ roles: ['MENTOR', 'MENTOR'], userIds: ['u1'] })).toEqual({ roles: ['MENTOR'] });
  expect(audienceWhere(null)).toEqual({});
});

test('a forged recipient list has nowhere to land, and malformed criteria are refused', { tag: '@smoke' }, () => {
  // `userIds` / `recipients` are not fields of the schema: they are dropped, never resolved.
  expect(parseAudience({ recipients: ['u1', 'u2'] })).toBeNull();
  expect(isValidAudienceInput({ roles: ['SUPERUSER'] })).toBe(false);
  expect(isValidAudienceInput({ cohortIds: 'c1' })).toBe(false);
  expect(isValidAudienceInput({ cohortIds: Array.from({ length: 51 }, (_, i) => `c${i}`) })).toBe(false);
  expect(isValidAudienceInput(null)).toBe(true);
  // A malformed value never narrows a broadcast by surprise: it parses as "no criteria".
  expect(parseAudience({ roles: ['SUPERUSER'] })).toBeNull();
});

test('within a dimension the values are alternatives; across dimensions they all apply', { tag: '@smoke' }, () => {
  expect(audienceWhere({ roles: ['MENTOR', 'MENTEE'] })).toEqual({ role: { in: ['MENTOR', 'MENTEE'] } });
  const where = audienceWhere({ roles: ['MENTOR'], cohortIds: ['c1'] }) as { AND: unknown[] };
  expect(where.AND).toHaveLength(2);
  expect(where.AND[1]).toEqual({
    OR: [
      { mentorRelations: { some: { status: 'ACTIVE', cohortId: { in: ['c1'] } } } },
      { menteeRelations: { some: { status: 'ACTIVE', cohortId: { in: ['c1'] } } } },
    ],
  });
  expect(audienceWhere({ stages: ['STAGE_A'] })).toEqual({ menteeRelations: { some: { status: 'ACTIVE', pipelineStatus: { in: ['STAGE_A'] } } } });
  expect(audienceWhere({ tagIds: ['t1'] })).toEqual({ tags: { some: { tagId: { in: ['t1'] } } } });
});
