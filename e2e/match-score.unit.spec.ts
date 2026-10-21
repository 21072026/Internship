// Unit tests for the pure match scorer (#1781). Pure node — no browser, no DB.
//
// The last test is the one that matters most: with nothing configured, the
// built-in rule set must rank mentors exactly as the inline sort in
// /api/admin/mentor-suggest did before #1781 — that sort is copied below as
// the oracle, so a drift in either shows up here.
import { test, expect } from '@playwright/test';
import { DEFAULT_RULE_SET, rankMatches, scoreMatch, type MatchRuleSetInput } from '@/lib/matching/score';
import type { MatchMentee, MatchMentor } from '@/lib/matching/dimensions';
import { normalizeTerm } from '@/lib/matching/normalize';

const NOW = { now: new Date('2026-10-20T12:00:00Z') };

const mentee = (over: Partial<MatchMentee> = {}): MatchMentee => ({ id: 'me', skills: ['React', 'SQL', 'Go', 'Figma'], ...over });
const mentor = (id: string, over: Partial<MatchMentor> = {}): MatchMentor => ({ id, skills: [], activeMenteeCount: 0, ...over });

const set = (rules: MatchRuleSetInput['rules']): MatchRuleSetInput => ({ id: 'rs', name: 'test', version: 1, rules });

test.describe('match score', { tag: '@smoke' }, () => {
  test('weighted parts sum to the stated percentage', () => {
    const rs = set([
      { dimension: 'skills', kind: 'WEIGHTED', weight: 60 },
      { dimension: 'city', kind: 'WEIGHTED', weight: 30 },
      { dimension: 'language', kind: 'WEIGHTED', weight: 10 },
    ]);
    const m = scoreMatch(
      mentee({ city: 'Köln', languages: ['de', 'en'] }),
      mentor('a', { skills: ['react', 'sql'], city: 'koln', languages: ['EN'] }),
      rs,
      NOW
    );
    // skills 2/4 × 60 + city 1 × 30 + language 1/2 × 10 = 30 + 30 + 5
    expect(m.score).toBeCloseTo(65, 6);
    expect(m.breakdown.reduce((s, e) => s + e.contribution, 0)).toBeCloseTo(m.score, 6);
    expect(m.breakdown.map((e) => e.contribution)).toEqual([30, 30, 5]);
    expect(m.breakdown[0].detail).toEqual(['React', 'SQL']);
    expect(m.blockedBy).toEqual([]);
  });

  test('a hard-require failure zeroes the score and names the rule', () => {
    const rs = set([
      { dimension: 'skills', kind: 'WEIGHTED', weight: 100 },
      { dimension: 'language', kind: 'HARD_REQUIRE', weight: 0 },
    ]);
    const m = scoreMatch(mentee({ preferredLanguages: ['Türkçe'] }), mentor('a', { skills: ['react'], languages: ['English'] }), rs, NOW);
    expect(m.score).toBe(0);
    expect(m.blockedBy).toEqual(['language']);
    expect(m.breakdown.every((e) => e.contribution === 0)).toBe(true);
    expect(m.breakdown.find((e) => e.dimension === 'language')?.passed).toBe(false);
    // A mentee with no language at all is not blocked from everyone.
    expect(scoreMatch(mentee(), mentor('a', { skills: ['react'] }), rs, NOW).blockedBy).toEqual([]);
  });

  test('manager exclusion blocks the direct manager, both ways round', () => {
    const rs = set([
      { dimension: 'skills', kind: 'WEIGHTED', weight: 100 },
      { dimension: 'managerExclusion', kind: 'HARD_EXCLUDE', weight: 0 },
    ]);
    expect(scoreMatch(mentee({ managerId: 'boss' }), mentor('boss', { skills: ['react'] }), rs, NOW).blockedBy).toEqual(['managerExclusion']);
    expect(scoreMatch(mentee(), mentor('report', { managerId: 'me', skills: ['react'] }), rs, NOW).blockedBy).toEqual(['managerExclusion']);
    expect(scoreMatch(mentee({ managerId: 'boss' }), mentor('other', { skills: ['react'] }), rs, NOW).score).toBe(25);
  });

  test('previous pairing blocks two people who already had a relation', () => {
    const rs = set([{ dimension: 'previousPairing', kind: 'HARD_EXCLUDE', weight: 0 }]);
    const m = scoreMatch(mentee({ pastMentorIds: ['old'] }), mentor('old'), rs, NOW);
    expect(m).toMatchObject({ score: 0, blockedBy: ['previousPairing'] });
    expect(scoreMatch(mentee({ pastMentorIds: ['old'] }), mentor('new'), rs, NOW).blockedBy).toEqual([]);
  });

  test('an empty rule set falls back to the default', () => {
    const a = mentor('a', { skills: ['react', 'go'] });
    expect(scoreMatch(mentee(), a, set([]), NOW)).toEqual(scoreMatch(mentee(), a, DEFAULT_RULE_SET, NOW));
    expect(scoreMatch(mentee(), a, null, NOW).score).toBeCloseTo(50, 6);
  });

  test('the default set reproduces the pre-#1781 skill-overlap-then-load ordering', () => {
    const me = mentee();
    const pool: (MatchMentor & { fullName: string })[] = [
      { id: 'm1', fullName: 'One', skills: ['react'], activeMenteeCount: 3, mentorCapacity: 5 },
      { id: 'm2', fullName: 'Two', skills: ['React', 'SQL'], activeMenteeCount: 4, mentorCapacity: null },
      { id: 'm3', fullName: 'Three', skills: ['sql', 'go'], activeMenteeCount: 1, mentorCapacity: 2 },
      { id: 'm4', fullName: 'Four', skills: ['figma', 'react', 'go'], activeMenteeCount: 2, mentorCapacity: 2 }, // full
      { id: 'm5', fullName: 'Five', skills: [], activeMenteeCount: 0, mentorCapacity: null },
      { id: 'm6', fullName: 'Six', skills: ['GO'], activeMenteeCount: 3, mentorCapacity: 9 },
      { id: 'm7', fullName: 'Seven', skills: ['react'], activeMenteeCount: 0, mentorCapacity: 1, acceptingMentees: false },
      { id: 'm8', fullName: 'Eight', skills: ['ReactJS'], activeMenteeCount: 0, mentorCapacity: null },
    ];

    // The oracle: the inline sort from src/app/api/admin/mentor-suggest/route.ts before #1781.
    const menteeSkills = new Set((me.skills as string[]).map((s) => s.toLowerCase()));
    const legacy = pool
      .map((m) => ({
        m,
        overlap: (m.skills as string[]).filter((s) => menteeSkills.has(s.toLowerCase())),
        over: m.mentorCapacity != null && m.activeMenteeCount >= m.mentorCapacity,
      }))
      .filter((x) => !x.over)
      .sort((a, b) => b.overlap.length - a.overlap.length || a.m.activeMenteeCount - b.m.activeMenteeCount)
      .map((x) => x.m.id);

    const ranked = rankMatches(me, pool, null, NOW);
    expect(ranked.filter((r) => r.match.blockedBy.length === 0).map((r) => r.mentor.id)).toEqual(legacy);
    // The full mentor is not dropped in silence: it is last, named as blocked.
    expect(ranked.at(-1)).toMatchObject({ mentor: { id: 'm4' }, match: { score: 0, blockedBy: ['capacityHeadroom'] } });
  });
});

test.describe('match score — dimensions', { tag: '@smoke' }, () => {
  test('normalisation folds case, accents, punctuation and aliases — never categories', () => {
    expect(normalizeTerm(' React.js ')).toBe('react');
    expect(normalizeTerm('JS')).toBe('javascript');
    expect(normalizeTerm('Node.js')).toBe('node');
    expect(normalizeTerm('C++')).toBe('c++');
    expect(normalizeTerm('Yazılım')).toBe(normalizeTerm('yazilim'));
    expect(normalizeTerm('react')).not.toBe(normalizeTerm('frontend'));
  });

  test('timezone counts hours apart and honours maxHours', () => {
    const rs = set([{ dimension: 'timezone', kind: 'HARD_REQUIRE', weight: 0, config: { maxHours: 2 } }]);
    const berlin = mentee({ timezone: 'Europe/Berlin' });
    expect(scoreMatch(berlin, mentor('a', { timezone: 'Europe/Istanbul' }), rs, NOW).blockedBy).toEqual([]);
    expect(scoreMatch(berlin, mentor('b', { timezone: 'America/New_York' }), rs, NOW).blockedBy).toEqual(['timezone']);
  });

  test('capacity headroom honours the mentor’s own "not accepting" only when asked', () => {
    const closed = mentor('a', { acceptingMentees: false, activeMenteeCount: 0, mentorCapacity: 3 });
    const plain = set([{ dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE', weight: 0 }]);
    const strict = set([{ dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE', weight: 0, config: { honourPreference: true } }]);
    expect(scoreMatch(mentee(), closed, plain, NOW).blockedBy).toEqual([]);
    expect(scoreMatch(mentee(), closed, strict, NOW).blockedBy).toEqual(['capacityHeadroom']);
  });

  test('an unknown dimension is a non-match, never a silent pass', () => {
    const rs = set([{ dimension: 'astrology', kind: 'HARD_REQUIRE', weight: 0 }]);
    expect(scoreMatch(mentee(), mentor('a'), rs, NOW).blockedBy).toEqual(['astrology']);
  });

  test('all-zero weights score 0, not NaN', () => {
    const m = scoreMatch(mentee(), mentor('a', { skills: ['react'] }), set([{ dimension: 'skills', kind: 'WEIGHTED', weight: 0 }]), NOW);
    expect(m.score).toBe(0);
  });
});
