import { test, expect } from '@playwright/test';
import { computeSlaCompliance } from '@/lib/slaCompliance';
import { slaDaysByStage } from '@/lib/stageSlaRule';

// #1723 — the compliance rate's arithmetic, browserless.

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date('2026-09-01T00:00:00Z').getTime();
const d = (days: number) => new Date(t0 + days * DAY);
const window = { from: d(0), to: d(100) };
const slas = new Map([
  ['A', 5],
  ['B', 3],
]);
const stopped = (k: string) => k === 'DONE';

test.describe('SLA compliance rate', () => {
  test('counts moves out of a stage with a service level, met when inside it', () => {
    const r = computeSlaCompliance(
      [
        {
          startDate: d(0),
          statusChanges: [
            { fromStatus: 'A', toStatus: 'B', createdAt: d(4) }, // A: 4 ≤ 5 met
            { fromStatus: 'B', toStatus: 'C', createdAt: d(10) }, // B: 6 > 3 missed
            { fromStatus: 'C', toStatus: 'DONE', createdAt: d(20) }, // C: no SLA, not counted
          ],
        },
      ],
      slas,
      window,
      stopped
    );
    expect(r).toMatchObject({ met: 1, total: 2, rate: 50 });
  });

  test('moves outside the period, out of stopped stages and no-ops are not counted', () => {
    const r = computeSlaCompliance(
      [
        {
          startDate: d(-20),
          statusChanges: [
            { fromStatus: 'A', toStatus: 'A', createdAt: d(-15) },
            { fromStatus: 'A', toStatus: 'B', createdAt: d(-10) }, // before the window
            { fromStatus: 'B', toStatus: 'DONE', createdAt: d(-9) },
          ],
        },
      ],
      new Map([...slas, ['DONE', 1]]),
      window,
      stopped
    );
    expect(r).toMatchObject({ met: 0, total: 0, rate: null });
  });

  test('no measured move is a null rate, never a fake 100%', () => {
    expect(computeSlaCompliance([], slas, window, stopped).rate).toBeNull();
  });
  // #3204 — each relation is judged against its OWN resolved service level.
  test('a relation in a mentor override is judged by the override, not the org', () => {
    const rows = [
      { stageKey: 'A', days: 7 },
      { stageKey: 'A', days: 20, mentorId: 'busy' },
    ];
    const moveOnDay15 = (mentorId: string) => ({
      startDate: d(0),
      mentorId,
      statusChanges: [{ fromStatus: 'A', toStatus: 'B', createdAt: d(15) }],
    });
    const perRelation = (r: { cohortId?: string | null; mentorId?: string | null }) => slaDaysByStage(rows, r);
    const res = computeSlaCompliance([moveOnDay15('busy'), moveOnDay15('other')], perRelation, window, stopped);
    // busy: 15 ≤ 20 met · other: 15 > 7 missed
    expect(res).toMatchObject({ met: 1, total: 2, rate: 50 });
    // With org rows only, the per-relation form answers exactly what the single map did.
    const orgOnly = computeSlaCompliance([moveOnDay15('busy')], (r) => slaDaysByStage([rows[0]], r), window, stopped);
    expect(orgOnly).toEqual(computeSlaCompliance([moveOnDay15('busy')], new Map([['A', 7]]), window, stopped));
  });
});
