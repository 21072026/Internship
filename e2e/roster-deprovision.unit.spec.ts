import { test, expect } from '@playwright/test';
import {
  checkRowFloor,
  planDeprovision,
  rosterActor,
  utcDaysBetween,
  type DeprovisionCandidate,
  type DeprovisionSettings,
} from '@/lib/rosterDeprovisionRule';

// The deprovisioning rules (#1966), without a database. Every valve is a hard
// requirement, and every one of them is wrong in a way that type-checks: a
// ceiling counted on the wrong population, a grace that counts hours instead of
// runs, a guard that only looks at the person and not at who is left.

const FEED = 'feed-1';
const settings = (over: Partial<DeprovisionSettings> = {}): DeprovisionSettings => ({
  feedId: FEED,
  deprovision: true,
  maxDeactivatePercent: 10,
  minRowCount: 1,
  deprovisionGraceDays: 1,
  ...over,
});
const person = (id: string, over: Partial<DeprovisionCandidate> = {}): DeprovisionCandidate => ({
  id,
  role: 'MENTEE',
  isActive: true,
  ssoExempt: false,
  rosterAbsentSince: null,
  deactivatedBy: null,
  ...over,
});
const NOW = new Date('2026-10-21T02:00:00Z');
const YESTERDAY = new Date('2026-10-20T02:00:00Z');
const EARLIER_TODAY = new Date('2026-10-21T00:30:00Z');

const base = { present: [], coveredActiveCount: 100, activeAdminCount: 2, now: NOW };

test.describe('roster deprovisioning rules', { tag: '@smoke' }, () => {
  test('the row floor stops a file with too few rows', () => {
    expect(checkRowFloor(0, 1)).toEqual({ reason: 'row_floor', rowCount: 0, minRowCount: 1 });
    expect(checkRowFloor(49, 50)?.reason).toBe('row_floor');
    expect(checkRowFloor(50, 50)).toBeNull();
    expect(checkRowFloor(0, 0)).toBeNull();
  });

  test('grace: absent once is a stamp, absent on a later day is a deactivation', () => {
    const first = planDeprovision({ ...base, settings: settings(), absent: [person('a')] });
    expect(first.markAbsent).toEqual(['a']);
    expect(first.deactivate).toEqual([]);

    // Stamped earlier the same UTC day: still waiting (two runs one night is
    // not two nights).
    const sameDay = planDeprovision({
      ...base,
      settings: settings(),
      absent: [person('a', { rosterAbsentSince: EARLIER_TODAY })],
    });
    expect(sameDay.waiting).toEqual(['a']);
    expect(sameDay.deactivate).toEqual([]);

    const nextDay = planDeprovision({
      ...base,
      settings: settings(),
      absent: [person('a', { rosterAbsentSince: YESTERDAY })],
    });
    expect(nextDay.deactivate).toEqual(['a']);

    // A longer grace waits longer.
    const longer = planDeprovision({
      ...base,
      settings: settings({ deprovisionGraceDays: 3 }),
      absent: [person('a', { rosterAbsentSince: YESTERDAY })],
    });
    expect(longer.waiting).toEqual(['a']);
    expect(utcDaysBetween(YESTERDAY, NOW)).toBe(1);
  });

  test('reappearing clears the stamp, so absence starts over', () => {
    const back = planDeprovision({
      ...base,
      settings: settings(),
      absent: [],
      present: [person('a', { rosterAbsentSince: YESTERDAY })],
    });
    expect(back.clearAbsent).toEqual(['a']);
    expect(back.deactivate).toEqual([]);
  });

  test('the ceiling counts everyone on the way out and stops the run', () => {
    // 11 of 100 absent (all first-time) is over 10%: caught on the night the
    // bad file arrives, not one grace period later.
    const absent = Array.from({ length: 11 }, (_, i) => person(`p${i}`));
    const plan = planDeprovision({ ...base, settings: settings(), absent });
    expect(plan.abort).toEqual({ reason: 'deactivation_ceiling', planned: 11, covered: 100, maxPercent: 10 });

    expect(planDeprovision({ ...base, settings: settings(), absent: absent.slice(0, 10) }).abort).toBeNull();
    // An admin's approval (#1967) lifts this valve and only this one.
    expect(planDeprovision({ ...base, settings: settings(), absent, approved: true }).abort).toBeNull();
    // Already-inactive people are not part of the count.
    const inactive = absent.map((p) => ({ ...p, isActive: false }));
    expect(planDeprovision({ ...base, settings: settings(), absent: inactive }).abort).toBeNull();
  });

  test('never the last active admin, never an SSO break-glass account', () => {
    const plan = planDeprovision({
      ...base,
      activeAdminCount: 1,
      settings: settings(),
      absent: [
        person('admin', { role: 'ADMIN', rosterAbsentSince: YESTERDAY }),
        person('exempt', { ssoExempt: true, rosterAbsentSince: YESTERDAY }),
      ],
    });
    expect(plan.deactivate).toEqual([]);
    expect(plan.refused).toEqual([
      { id: 'admin', reason: 'last_admin' },
      { id: 'exempt', reason: 'sso_exempt' },
    ]);

    // Two admins both due: the first may go, the second is the last one left.
    const two = planDeprovision({
      ...base,
      activeAdminCount: 2,
      settings: settings(),
      absent: [
        person('a1', { role: 'ADMIN', rosterAbsentSince: YESTERDAY }),
        person('a2', { role: 'ADMIN', rosterAbsentSince: YESTERDAY }),
      ],
    });
    expect(two.deactivate).toEqual(['a1']);
    expect(two.refused).toEqual([{ id: 'a2', reason: 'last_admin' }]);
  });

  test('only what the feed switched off is switched back on', () => {
    const plan = planDeprovision({
      ...base,
      settings: settings(),
      absent: [],
      present: [
        person('byFeed', { isActive: false, deactivatedBy: rosterActor(FEED) }),
        person('byOtherFeed', { isActive: false, deactivatedBy: rosterActor('feed-2') }),
        person('byAdmin', { isActive: false, deactivatedBy: 'admin-user-id' }),
        person('legacy', { isActive: false, deactivatedBy: null }),
      ],
    });
    expect(plan.reactivate).toEqual(['byFeed']);
  });

  test('switched off, the feed only reactivates and stamps nothing', () => {
    const plan = planDeprovision({
      ...base,
      settings: settings({ deprovision: false }),
      absent: [person('a', { rosterAbsentSince: YESTERDAY })],
      present: [person('b', { isActive: false, deactivatedBy: rosterActor(FEED) })],
    });
    expect(plan.deactivate).toEqual([]);
    expect(plan.markAbsent).toEqual([]);
    expect(plan.reactivate).toEqual(['b']);
    expect(plan.abort).toBeNull();
  });
});
