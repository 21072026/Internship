import { test, expect } from '@playwright/test';
import { answerPath, answeredCount, columnsToLoad, matchedSkills, parseBoardFilters } from '@/lib/requisitionBoard';
import { APPLICATION_STAGES } from '@/lib/applications';

// The applicant board's pure rules (#1838): what the query string may say, and
// the one place a screening-question id becomes part of a JSON path.

test('a screening answer filter only ever builds a path from a safe id', { tag: '@smoke' }, async () => {
  const ok = parseBoardFilters(new URLSearchParams('answer.relocate=true&answer.work-permit=EU&answer.note=false'));
  expect(ok.ok && ok.filters.answers).toEqual([
    { questionId: 'relocate', value: true },
    { questionId: 'work-permit', value: 'EU' },
    { questionId: 'note', value: false },
  ]);
  for (const bad of ['answer.a"b=1', 'answer.$=1', 'answer.a.b=1', 'answer.x=', 'answer.=1']) {
    expect(parseBoardFilters(new URLSearchParams(bad))).toEqual({ ok: false, code: 'invalid_answer_filter' });
  }
  const many = new URLSearchParams(Array.from({ length: 6 }, (_, i) => `answer.q${i}=x`).join('&'));
  expect(parseBoardFilters(many)).toEqual({ ok: false, code: 'too_many_answer_filters' });
  expect(answerPath('work-permit')).toBe('$."work-permit"');
  expect(() => answerPath('a"b')).toThrow();
});

test('stages, paging and the card summary', { tag: '@smoke' }, async () => {
  expect(parseBoardFilters(new URLSearchParams('stage=HIRING'))).toEqual({ ok: false, code: 'unknown_stage' });
  const parsed = parseBoardFilters(new URLSearchParams('pageSize=500&page=-3'));
  expect(parsed.ok && [parsed.filters.page, parsed.filters.pageSize]).toEqual([1, 50]);
  expect(columnsToLoad({ stage: null, column: null })).toEqual(APPLICATION_STAGES);
  expect(columnsToLoad({ stage: 'SCREENING', column: 'APPLIED' })).toEqual(['APPLIED']);
  expect(matchedSkills(['Yazılım', 'react', 'React', 'Go'], ['yazilim', 'REACT'])).toEqual(['Yazılım', 'react']);
  expect(matchedSkills(null, ['x'])).toEqual([]);
  expect(answeredCount({ a: 'yes', b: false, c: '', d: null })).toBe(2);
  expect(answeredCount(['a'])).toBe(0);
});
