// Which outcome a stage lands on (#830), after #1880 moved the knowledge of
// what the canonical off-path stages MEAN into the catalogue
// (canonicalOffPathMeaning, src/lib/pipeline.ts). Pure node, no browser — run
// with BASE_URL=http://localhost:9 to skip the webServer.
import { test, expect } from '@playwright/test';
import { outcomeForStage, isCelebratory } from '@/lib/outcomeComms';
import { canonicalOffPathMeaning, defaultPipelineStages } from '@/lib/pipeline';

test('the canonical catalogue: found-elsewhere is a success, dropped is not, on-path stages are no outcome', () => {
  expect(outcomeForStage('INTERNSHIP_FOUND_ELSEWHERE_800')).toBe('placedElsewhere');
  expect(isCelebratory(outcomeForStage('INTERNSHIP_FOUND_ELSEWHERE_800')!)).toBe(true);
  expect(outcomeForStage('INTERNSHIP_DROPPED_460')).toBe('noMatch');
  expect(outcomeForStage('HIRED_660')).toBeNull();
  expect(outcomeForStage('APPLICATION_100')).toBeNull();
});

test('every canonical off-path stage has a stated meaning, and no on-path one does', () => {
  for (const stage of defaultPipelineStages()) {
    expect(canonicalOffPathMeaning(stage.key) !== null, stage.key).toBe(stage.isOffPath);
  }
});

test("a tenant's own off-path stage takes the neutral wording; its on-path stages are no outcome", () => {
  expect(outcomeForStage('STAGE_WITHDREW', { isOffPath: true })).toBe('noMatch');
  expect(outcomeForStage('STAGE_WITHDREW', { isOffPath: false })).toBeNull();
  expect(outcomeForStage('STAGE_WITHDREW')).toBeNull();
  // The canonical meaning wins over a tenant flag: the success/rejection split
  // cannot be lost to a stage configuration.
  expect(outcomeForStage('INTERNSHIP_FOUND_ELSEWHERE_800', { isOffPath: false })).toBe('placedElsewhere');
});

test('the drop-off reason still narrows the wording', () => {
  expect(outcomeForStage('INTERNSHIP_DROPPED_460', { reasonCode: 'ACCEPTED_ELSEWHERE' })).toBe('placedElsewhere');
  expect(outcomeForStage('STAGE_WITHDREW', { isOffPath: true, reasonCode: 'COMPANY_CANCELLED' })).toBe('poolInvite');
  expect(outcomeForStage('INTERNSHIP_DROPPED_460', { reasonCode: 'SKILL_MISMATCH' })).toBe('noMatch');
  // A reason never turns a non-ending into an ending.
  expect(outcomeForStage('STAGE_WORK', { reasonCode: 'ACCEPTED_ELSEWHERE' })).toBeNull();
});
