import { test, expect } from '@playwright/test';
import { defaultPipelineStages, groupResolvedStages, nextOnPathStage, type ResolvedStage } from '@/lib/pipeline';

// #1637 — board phases come from the stage, and "advance" walks the resolved
// order. Browserless.

const stage = (key: string, order: number, extra: Partial<ResolvedStage> = {}): ResolvedStage => ({
  key,
  label: key,
  order,
  isTerminal: false,
  isOffPath: false,
  color: null,
  ...extra,
});

test.describe('pipeline phases and the resolved advance order', { tag: '@smoke' }, () => {
  test('a tenant on the built-in stages sees the same three phases in the same order', () => {
    const groups = groupResolvedStages(defaultPipelineStages());
    expect(groups.map((g) => g.key)).toEqual(['pre', 'internship', 'result']);
    expect(groups[0].statuses[0]).toBe('APPLICATION_100');
    expect(groups[2].statuses).toContain('EMPLOYED_700');
  });

  test('a custom stage filed under a phase renders in that phase, in the tenant’s order', () => {
    const groups = groupResolvedStages([
      stage('INTAKE', 0, { phase: 'pre' }),
      stage('ON_SITE', 1, { phase: 'internship' }),
      stage('APPLICATION_100', 2), // canonical key, no phase: its built-in one
      stage('MISC', 3), // nobody filed it: the trailing custom group
      stage('PLACED', 4, { phase: 'result', isTerminal: true }),
      stage('ODD', 5, { phase: 'nonsense' }), // not on the whitelist: derive
    ]);
    expect(groups).toEqual([
      { key: 'pre', statuses: ['INTAKE', 'APPLICATION_100'] },
      { key: 'internship', statuses: ['ON_SITE'] },
      { key: 'result', statuses: ['PLACED'] },
      { key: 'custom', statuses: ['MISC', 'ODD'] },
    ]);
  });

  test('advance walks a fully custom on-path order and says why it stops', () => {
    const stages = [
      stage('A', 0),
      stage('B', 1),
      stage('GONE', 2, { isOffPath: true }),
      stage('C', 3, { isTerminal: true }),
    ];
    expect(nextOnPathStage(stages, 'A')).toEqual({ to: 'B' });
    // The off-path stage between B and C is never the target.
    expect(nextOnPathStage(stages, 'B')).toEqual({ to: 'C' });
    expect(nextOnPathStage(stages, 'C')).toEqual({ skip: 'final_stage' });
    expect(nextOnPathStage(stages, 'GONE')).toEqual({ skip: 'off_path' });
    expect(nextOnPathStage(stages, 'APPLICATION_100')).toEqual({ skip: 'unknown_stage' });
  });

  test('the built-in order advances exactly as before', () => {
    const stages = defaultPipelineStages();
    expect(nextOnPathStage(stages, 'APPLICATION_100')).toEqual({ to: 'APPROVAL_PENDING_220' });
    expect(nextOnPathStage(stages, 'INTERNSHIP_IN_PROGRESS_450')).toEqual({ to: 'INTERNSHIP_COMPLETED_490' });
    expect(nextOnPathStage(stages, 'HIRED_660')).toEqual({ to: 'EMPLOYED_700' });
    expect(nextOnPathStage(stages, 'EMPLOYED_700')).toEqual({ skip: 'final_stage' });
    expect(nextOnPathStage(stages, 'INTERNSHIP_DROPPED_460')).toEqual({ skip: 'off_path' });
  });
});
