import { test, expect } from '@playwright/test';
import { APPROACHING_SHARE, USAGE_ROWS, buildUsageSummary, usageState } from '@/lib/usageSummary';
import { planLimits } from '@/lib/plans';

// The usage tab's arithmetic (#1763), without a database. Two promises are
// load-bearing: an unlimited (null) limit is never rendered as 0 or as over —
// that would show a paying customer as over-band — and video is reported,
// never limited.

test('state: null limit is unlimited, 0 is not included, video is reported', { tag: '@smoke' }, () => {
  expect(usageState(10_000, null, true)).toBe('unlimited');
  expect(usageState(null, null, true)).toBe('unlimited');
  expect(usageState(3, 0, true)).toBe('not_included');
  expect(usageState(9_999, null, false)).toBe('reported');
  expect(usageState(null, 10, true)).toBe('pending');
  expect(usageState(7, 10, true)).toBe('ok');
  expect(usageState(10 * APPROACHING_SHARE, 10, true)).toBe('approaching');
  expect(usageState(10, 10, true)).toBe('approaching');
  expect(usageState(11, 10, true)).toBe('over');
});

test('summary: four periods oldest first, the current one from the ledger, unknown plan = free tier', { tag: '@smoke' }, () => {
  const at = '2026-10-27T03:00:00.000Z';
  const s = buildUsageSummary({
    planKey: 'not-a-plan',
    period: '2026-10',
    rollups: [
      { metric: 'ACTIVE_MATCHED_PAIRS', period: '2026-10', value: 999, computedAt: at },
      { metric: 'ACTIVE_MATCHED_PAIRS', period: '2026-08', value: 4, computedAt: at },
      { metric: 'VIDEO_ROOM', period: '2026-10', value: 50, computedAt: at },
    ],
  });
  expect(s.plan.key).toBe('community');
  expect(s.rows.map((r) => r.key)).toEqual(USAGE_ROWS.map((r) => r.key));
  const pairs = s.rows.find((r) => r.key === 'activePairs')!;
  expect(pairs.history.map((h) => h.period)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
  expect(pairs.history.map((h) => h.value)).toEqual([null, 4, null, 999]);
  expect(pairs.limit).toBe(planLimits('community').activePairs);
  expect(pairs.state).toBe('over');
  expect(s.anyOver).toBe(true);
  const video = s.rows.find((r) => r.key === 'videoRooms')!;
  expect(video.limit).toBeNull();
  expect(video.state).toBe('reported');
  expect(s.computedAt).toBe(at);
});

test('an unlimited plan is never over, and the broadcast cap can only come from the gate', { tag: '@smoke' }, () => {
  const s = buildUsageSummary({
    planKey: 'enterprise',
    period: '2026-10',
    rollups: [{ metric: 'ACTIVE_MATCHED_PAIRS', period: '2026-10', value: 100_000, computedAt: '2026-10-27T03:00:00.000Z' }],
    broadcastLimit: 500,
  });
  expect(s.rows.find((r) => r.key === 'activePairs')!.state).toBe('unlimited');
  expect(s.rows.find((r) => r.key === 'broadcastRecipients')!.limit).toBe(500);
  expect(s.anyOver).toBe(false);
});
