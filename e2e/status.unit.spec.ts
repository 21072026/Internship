// Unit tests for the /status rules (#1604) — no browser, no database.
// Run with BASE_URL=http://localhost:9 to skip the webServer.
import { test, expect } from '@playwright/test';
import { SLOT_MS, buildReport, gradeJobs, gradeMail, slaTarget, slotOf, type Sample } from '../src/lib/statusRule';

const NOW = new Date('2026-10-29T12:02:00Z');
const slot = (minsAgo: number) => new Date(slotOf(NOW).getTime() - minsAgo * 60_000);
const ok = (at: Date): Sample => ({ at, mail: 'ok', jobs: 'ok' });

test.describe('status rules', { tag: '@smoke' }, () => {
  test('a slot is the 5-minute floor in UTC', () => {
    expect(slotOf(new Date('2026-10-29T12:04:59Z')).toISOString()).toBe('2026-10-29T12:00:00.000Z');
  });

  test('a complete last hour is operational and 100 %', () => {
    const samples = Array.from({ length: 12 }, (_, i) => ok(slot(i * 5)));
    const r = buildReport(samples, NOW);
    expect(r.overall).toBe('operational');
    expect(r.uptimePct).toBe(100);
    expect(r.components.map((c) => c.state)).toEqual(['operational', 'operational', 'operational']);
  });

  test('a missing slot is downtime, and a stale newest sample is down right now', () => {
    // 12 expected completed slots, slot 30 min ago missing → 11/12.
    const samples = Array.from({ length: 13 }, (_, i) => ok(slot(i * 5))).filter((s) => s.at.getTime() !== slot(30).getTime());
    expect(buildReport(samples, NOW).uptimePct).toBe(Math.round((11 / 12) * 100 * 1000) / 1000);
    const stale = buildReport([ok(slot(20)), ok(slot(25))], NOW);
    expect(stale.overall).toBe('down');
    expect(stale.components[0].state).toBe('down');
  });

  test('a degraded component degrades the overall state but stays available', () => {
    const r = buildReport([{ at: slot(0), mail: 'degraded', jobs: 'ok' }, ok(slot(5))], NOW);
    expect(r.overall).toBe('degraded');
    expect(r.components.find((c) => c.key === 'mail')!.state).toBe('degraded');
    expect(r.uptimePct).toBe(100);
  });

  test('no samples → unknown, no figure, 90 no-data days', () => {
    const r = buildReport([], NOW);
    expect(r.overall).toBe('unknown');
    expect(r.uptimePct).toBeNull();
    expect(r.days).toHaveLength(90);
    expect(new Set(r.days.map((d) => d.state))).toEqual(new Set(['nodata']));
  });

  test('days before the first sample are no-data, not downtime', () => {
    const r = buildReport([ok(slot(0)), ok(slot(5))], NOW);
    expect(r.days.slice(0, 89).every((d) => d.state === 'nodata')).toBe(true);
    expect(r.days[89].state).toBe('up');
    expect(r.since?.getTime()).toBe(slot(5).getTime());
    expect(SLOT_MS).toBe(300_000);
  });

  test('grading: mail after 3 failures or 30 min of deferral, jobs after 15 min of waiting', () => {
    expect(gradeMail({ failuresSinceOk: 2, deferredSinceOk: 0, firstDeferredSinceOkAt: null }, NOW)).toBe('ok');
    expect(gradeMail({ failuresSinceOk: 3, deferredSinceOk: 0, firstDeferredSinceOkAt: null }, NOW)).toBe('degraded');
    expect(gradeMail({ failuresSinceOk: 0, deferredSinceOk: 4, firstDeferredSinceOkAt: '2026-10-29T11:50:00Z' }, NOW)).toBe('ok');
    expect(gradeMail({ failuresSinceOk: 0, deferredSinceOk: 4, firstDeferredSinceOkAt: '2026-10-29T11:00:00Z' }, NOW)).toBe('degraded');
    expect(gradeJobs({ oldestPendingAgeSec: null })).toBe('ok');
    expect(gradeJobs({ oldestPendingAgeSec: 900 })).toBe('ok');
    expect(gradeJobs({ oldestPendingAgeSec: 901 })).toBe('degraded');
  });

  test('the SLA figure exists only when the operator set a sane one', () => {
    for (const off of [undefined, '', '100', '99.9999', '80', 'abc', '99,9']) expect(slaTarget(off)).toBeNull();
    expect(slaTarget('99.5')).toBe('99.5');
    expect(slaTarget(' 99.9 ')).toBe('99.9');
  });
});
