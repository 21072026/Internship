import { test, expect } from '@playwright/test';
import { journeyOf, recruitingFunnel, recruitingTrend, resolveWindow, sourceBreakdown, timeToFill } from '@/lib/recruitingAnalytics';

// The employer recruiting report's arithmetic (#1911), no browser, no database.

const d = (iso: string) => new Date(iso);

test('a malformed or inverted window falls back to the default instead of failing', { tag: '@smoke' }, async () => {
  const now = d('2026-10-20T12:00:00Z');
  const fallback = resolveWindow({ from: null, to: null }, now);
  expect(resolveWindow({ from: 'not-a-date', to: null }, now)).toEqual(fallback);
  const inverted = resolveWindow({ from: '2026-10-01', to: '2026-09-01' }, now);
  expect(inverted.from.getTime()).toBeLessThan(inverted.to.getTime());
  const explicit = resolveWindow({ from: '2026-01-01', to: '2026-03-31' }, now);
  expect(explicit.from.getMonth()).toBe(0);
  expect(explicit.to.getDate()).toBe(31);
});

test('time-to-fill leaves an unfilled role out — never a zero — and says how many it judged', { tag: '@smoke' }, async () => {
  expect(timeToFill([], 4)).toEqual({ filled: 0, considered: 4, medianDays: null, avgDays: null });
  const t = timeToFill([
    { openedAt: d('2026-01-01'), filledAt: d('2026-01-11') },
    { openedAt: d('2026-01-01'), filledAt: d('2026-01-31') },
  ], 5);
  expect(t).toEqual({ filled: 2, considered: 5, medianDays: 20, avgDays: 20 });
});

test('the funnel follows each application to the furthest stage; sources and trend count what happened', { tag: '@smoke' }, async () => {
  const hired = { createdAt: d('2026-02-01'), source: 'SELF', status: 'HIRED', events: [
    { toStage: 'APPLIED', createdAt: d('2026-02-01') }, { toStage: 'INTERVIEW', createdAt: d('2026-02-10') }, { toStage: 'OFFER', createdAt: d('2026-03-01') }, { toStage: 'HIRED', createdAt: d('2026-03-03') },
  ] };
  const dropped = { createdAt: d('2026-02-05'), source: 'SHORTLIST', status: 'REJECTED', events: [
    { toStage: 'SHORTLISTED', createdAt: d('2026-02-05') }, { toStage: 'REJECTED', createdAt: d('2026-02-20') },
  ] };
  expect(journeyOf(dropped).startStatus).toBe('SHORTLISTED');
  const { stages, timeToHire } = recruitingFunnel([hired, dropped]);
  const at = (k: string) => stages.find((s) => s.key === k)!;
  expect(at('APPLIED')).toMatchObject({ entered: 2, advanced: 2 });
  expect(at('SHORTLISTED')).toMatchObject({ entered: 2, advanced: 1, rate: 50 });
  expect(at('HIRED')).toMatchObject({ entered: 1, rate: null, terminal: true });
  expect(timeToHire).toMatchObject({ completed: 1, considered: 2, medianDays: 30 });
  expect(sourceBreakdown([hired, dropped])).toEqual([
    { source: 'SELF', applications: 1, hired: 1, conversion: 100 },
    { source: 'SHORTLIST', applications: 1, hired: 0, conversion: 0 },
    { source: 'ADMIN', applications: 0, hired: 0, conversion: null },
  ]);
  const trend = recruitingTrend({ from: d('2026-02-01T00:00:00Z'), to: d('2026-03-31T00:00:00Z') }, [hired.createdAt, dropped.createdAt], [
    { fromStage: null, toStage: 'APPLIED', createdAt: d('2026-02-01') },
    { fromStage: 'APPLIED', toStage: 'INTERVIEW', createdAt: d('2026-02-10') },
    { fromStage: 'SHORTLISTED', toStage: 'REJECTED', createdAt: d('2026-02-20') },
    { fromStage: 'OFFER', toStage: 'HIRED', createdAt: d('2026-03-03') },
  ]);
  expect(trend).toEqual([
    { month: '2026-02', applications: 2, advances: 1, hires: 0 },
    { month: '2026-03', applications: 0, advances: 0, hires: 1 },
  ]);
});
