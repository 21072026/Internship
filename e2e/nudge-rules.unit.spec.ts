// Nudge rules (#1684) — pure node, no browser, no database. Run with
// BASE_URL=http://localhost:9 to skip the webServer.
//
// The write-time gate, the per-person decision (caps, cooldown, dedupe and
// the two hard product limits) and the segment → Prisma translation.
import { test, expect } from '@playwright/test';
import {
  dedupeKeyFor,
  fillMessage,
  messageFor,
  missingLocales,
  nudgeSendJobKey,
  parseNudgeRuleInput,
  planRecipients,
  readStoredNudge,
  type RecipientFacts,
} from '@/lib/nudges/rule';
import { relationMatches, segmentUserWhere } from '@/lib/nudges/segment';

const OUTCOME = new Set(['HIRED_660', 'INTERNSHIP_DROPPED_460']);
const isOutcome = (k: string) => OUTCOME.has(k);
const body = { subjectEn: 'Hi', bodyEn: 'Hello {name}', subjectTr: 'Merhaba', bodyTr: 'Selam {name}', subjectDe: 'Hallo', bodyDe: 'Hallo {name}' };
const base = { name: 'Stuck at interview', trigger: { kind: 'scan' }, ...body };
const now = new Date('2026-10-27T12:00:00Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

function person(over: Partial<RecipientFacts> = {}): RecipientFacts {
  return { userId: 'u1', name: 'Ada Lovelace', role: 'MENTEE', reachable: true, dormant: false, atOutcome: false, recentSends: [], alreadySent: false, ...over };
}

test.describe('the nudge write-time gate', { tag: '@smoke' }, () => {
  test('a well-formed rule parses, disabled by default', () => {
    const r = parseNudgeRuleInput({ ...base, segment: { conditions: [{ field: 'stage', op: 'in', value: ['INTERVIEW_PENDING_250'] }, { field: 'daysInStage', op: 'gte', value: 10 }] } }, isOutcome);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule.enabled).toBe(false);
      expect(r.missingLocales).toEqual([]);
    }
  });

  test('a stage-change trigger is refused at write time — that engine is #1703', () => {
    for (const event of ['pipeline.stage_change', 'pipeline.stage.changed', 'application.stage_changed']) {
      const r = parseNudgeRuleInput({ ...base, trigger: { kind: 'event', event } }, isOutcome);
      expect(r).toMatchObject({ ok: false, code: 'stage_trigger' });
    }
    // Any other unlisted event is refused by the allowlist itself.
    expect(parseNudgeRuleInput({ ...base, trigger: { kind: 'event', event: 'offer.declined' } }, isOutcome)).toMatchObject({ ok: false, code: 'invalid' });
    expect(parseNudgeRuleInput({ ...base, trigger: { kind: 'event', event: 'meeting.completed' } }, isOutcome).ok).toBe(true);
  });

  test('an unknown segment field or operator is rejected, never passed through', () => {
    const cases = [
      { field: 'email', op: 'eq', value: 'x@example.com' },
      { field: 'stage', op: 'contains', value: ['X'] },
      { field: 'role', op: 'eq', value: 'ADMIN' },
      { field: 'role', op: 'eq', value: 'COMPANY' },
      { field: 'daysInStage', op: 'gte', value: '10' },
      { field: 'tag', op: 'has', value: 't1', where: { OR: [] } },
      { field: 'stage', op: 'in', value: { not: '' } },
    ];
    for (const c of cases) {
      const r = parseNudgeRuleInput({ ...base, segment: { conditions: [c] } }, isOutcome);
      expect(r.ok, JSON.stringify(c)).toBe(false);
    }
    // And the same refusal holds when a stored row is read back.
    expect(readStoredNudge({ trigger: { kind: 'scan' }, segment: { conditions: [{ field: 'email', op: 'eq', value: 'x' }] } })).toBeNull();
  });

  test('a segment that targets an outcome stage is refused — that copy is the mentor\'s', () => {
    const r = parseNudgeRuleInput({ ...base, segment: { conditions: [{ field: 'stage', op: 'in', value: ['HIRED_660'] }] } }, isOutcome);
    expect(r).toMatchObject({ ok: false, code: 'outcome_stage' });
  });

  test('missing languages are reported; no language at all is refused', () => {
    const r = parseNudgeRuleInput({ name: 'x', trigger: { kind: 'scan' }, subjectEn: 'Hi', bodyEn: 'Hello' }, isOutcome);
    expect(r).toMatchObject({ ok: true, missingLocales: ['tr', 'de'] });
    expect(parseNudgeRuleInput({ name: 'x', trigger: { kind: 'scan' } }, isOutcome)).toMatchObject({ ok: false, code: 'no_message' });
    // In-app needs no subject.
    expect(missingLocales({ channel: 'IN_APP', bodyEn: 'a', bodyTr: 'b', bodyDe: 'c' })).toEqual([]);
    expect(missingLocales({ channel: 'EMAIL', bodyEn: 'a', bodyTr: 'b', bodyDe: 'c' })).toEqual(['en', 'tr', 'de']);
  });
});

test.describe('the per-person decision', { tag: '@smoke' }, () => {
  const rule = { maxPerUserPer30Days: 2, cooldownDays: 7 };

  test('dedupe: someone who already got this key is not sent again', () => {
    const p = planRecipients([person({ alreadySent: true }), person({ userId: 'u2' })], rule, now);
    expect(p.send.map((s) => s.userId)).toEqual(['u2']);
    expect(p.dropped.already_sent).toBe(1);
  });

  test('cooldown and the 30-day cap count every nudge the person got', () => {
    expect(planRecipients([person({ recentSends: [daysAgo(3)] })], rule, now).dropped.cooldown).toBe(1);
    expect(planRecipients([person({ recentSends: [daysAgo(8), daysAgo(20)] })], rule, now).dropped.cap).toBe(1);
    expect(planRecipients([person({ recentSends: [daysAgo(8), daysAgo(40)] })], rule, now).send).toHaveLength(1);
    expect(planRecipients([person({ recentSends: [daysAgo(1)] })], { maxPerUserPer30Days: 5, cooldownDays: 0 }, now).send).toHaveLength(1);
  });

  test('an unsubscribed person is never sent', () => {
    expect(planRecipients([person({ reachable: false })], rule, now).dropped.unsubscribed).toBe(1);
  });

  test('the dormancy guard: no third mail to a dormant first contact, whatever the rule says', () => {
    const generous = { maxPerUserPer30Days: 10, cooldownDays: 0 };
    const p = planRecipients([person({ dormant: true })], generous, now);
    expect(p.send).toHaveLength(0);
    expect(p.dropped.dormancy).toBe(1);
  });

  test('no outcome copy: a mentee at an outcome stage is never sent a nudge', () => {
    const p = planRecipients([person({ atOutcome: true })], { maxPerUserPer30Days: 10, cooldownDays: 0 }, now);
    expect(p.dropped.outcome).toBe(1);
    // The guards are about the mentee; a mentor is not held by them.
    expect(planRecipients([person({ role: 'MENTOR', dormant: true, atOutcome: true })], rule, now).send).toHaveLength(1);
  });

  test('dedupe keys and job keys', () => {
    expect(dedupeKeyFor({ kind: 'event', event: 'meeting.completed' }, 'e1')).toBe('evt:e1');
    expect(dedupeKeyFor({ kind: 'scan' })).toBe('scan');
    expect(nudgeSendJobKey('r', 'u', 'scan')).toBe('nudge:r:u:scan');
  });

  test('message: the reader\'s language, else English, else the first written; {name} is the only placeholder', () => {
    expect(messageFor(body, 'tr')).toMatchObject({ locale: 'tr', body: 'Selam {name}' });
    expect(messageFor({ bodyEn: 'Hello' }, 'de')).toMatchObject({ locale: 'en', body: 'Hello' });
    expect(messageFor({ bodyDe: 'Hallo' }, 'tr')).toMatchObject({ locale: 'de' });
    expect(messageFor({}, 'en')).toBeNull();
    expect(fillMessage('Hi {name}, {name}!', 'Ada Lovelace')).toBe('Hi Ada, Ada!');
    expect(fillMessage('Hi {name} ${process.env.X} {{x}}', null)).toBe('Hi  ${process.env.X} {{x}}');
  });
});

test.describe('the segment → Prisma translation', { tag: '@smoke' }, () => {
  test('every condition becomes a fixed column and operator, scoped to the org and active people', () => {
    const where = segmentUserWhere(
      {
        conditions: [
          { field: 'role', op: 'eq', value: 'MENTEE' },
          { field: 'stage', op: 'in', value: ['INTERVIEW_PENDING_250'] },
          { field: 'cohort', op: 'in', value: ['c1'] },
          { field: 'tag', op: 'has', value: 't1' },
          { field: 'daysSinceLastInteraction', op: 'gte', value: 14 },
        ],
      },
      'org-a',
      now,
    );
    expect(where.orgId).toBe('org-a');
    expect(where.isActive).toBe(true);
    const json = JSON.stringify(where);
    expect(json).toContain('"role":"MENTEE"');
    expect(json).not.toContain('"role":"MENTOR"');
    expect(json).toContain('"pipelineStatus":{"in":["INTERVIEW_PENDING_250"]}');
    expect(json).toContain('"cohortId":{"in":["c1"]}');
    expect(json).toContain('"tags":{"some":{"tagId":"t1"}}');
    expect(json).toContain('"interactions":{"none":{"date":{"gte"');
    // Relation conditions are scoped to the org's ACTIVE relations.
    expect(json).toContain('"status":"ACTIVE","orgId":"org-a"');
  });

  test('no role condition reaches both mentors and mentees, never anyone else', () => {
    const where = segmentUserWhere({ conditions: [] }, 'org-a', now);
    expect((where.OR as { role: string }[]).map((w) => w.role).sort()).toEqual(['MENTEE', 'MENTOR']);
  });

  test('hasNoMentor never matches a mentor', () => {
    const where = segmentUserWhere({ conditions: [{ field: 'hasNoMentor', op: 'eq', value: true }] }, 'org-a', now);
    const mentor = (where.OR as Record<string, unknown>[]).find((w) => JSON.stringify(w).includes('"in":[]'));
    expect(mentor).toBeTruthy();
  });

  test('days in stage is judged exactly by the stage clock', () => {
    const seg = { conditions: [{ field: 'daysInStage' as const, op: 'gte' as const, value: 10 }] };
    const rel = { pipelineStatus: 'X', cohortId: null, startDate: daysAgo(60), lastInteractionAt: null, statusChanges: [] as { createdAt: Date; fromStatus: string; toStatus: string }[] };
    expect(relationMatches(seg, { ...rel, statusChanges: [{ createdAt: daysAgo(12), fromStatus: 'A', toStatus: 'X' }] }, now)).toBe(true);
    expect(relationMatches(seg, { ...rel, statusChanges: [{ createdAt: daysAgo(5), fromStatus: 'A', toStatus: 'X' }] }, now)).toBe(false);
    // A no-op row is not a move (#2264): the clock keeps counting from the real one.
    expect(relationMatches(seg, { ...rel, statusChanges: [{ createdAt: daysAgo(2), fromStatus: 'X', toStatus: 'X' }, { createdAt: daysAgo(30), fromStatus: 'A', toStatus: 'X' }] }, now)).toBe(true);
  });
});
