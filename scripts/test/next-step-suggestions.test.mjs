// Unit tests for the follow-up panel's ready-made next steps (#2875).
//
// The catalogue is data, and the three ways data like this rots are silent:
// a locale that lost a stage, a line that outgrew the chip width, and a
// stage key that drifted from the pipeline catalogue. None of it is reachable
// from a browser (the panel renders whatever it gets), so it is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { NEXT_STEP_SUGGESTIONS, NEXT_STEP_LINE_MAX, nextStepSuggestions } = await import('../../src/lib/nextStepSuggestions.ts');
const { PIPELINE_STATUSES } = await import('../../src/lib/pipeline.ts');
const { NEXT_ACTION_NOTE_MAX } = await import('../../src/lib/nextActionRule.ts');
const { locales } = await import('../../src/i18n/config.ts');

test('every locale covers every canonical stage with two or three distinct lines', () => {
  for (const locale of locales) {
    const byStage = NEXT_STEP_SUGGESTIONS[locale];
    assert.ok(byStage, `${locale}: no catalogue`);
    for (const key of PIPELINE_STATUSES) {
      const lines = byStage[key];
      assert.ok(Array.isArray(lines), `${locale}.${key}: missing`);
      assert.ok(lines.length >= 2 && lines.length <= 3, `${locale}.${key}: ${lines.length} lines`);
      assert.equal(new Set(lines.map((l) => l.toLowerCase())).size, lines.length, `${locale}.${key}: duplicate line`);
    }
    // No stage that the pipeline catalogue does not know.
    for (const key of Object.keys(byStage)) {
      assert.ok(PIPELINE_STATUSES.includes(key), `${locale}: unknown stage key ${key}`);
    }
  }
});

test('every line is a chip, not a paragraph', () => {
  assert.ok(NEXT_STEP_LINE_MAX < NEXT_ACTION_NOTE_MAX);
  for (const locale of locales) {
    for (const [key, lines] of Object.entries(NEXT_STEP_SUGGESTIONS[locale])) {
      for (const line of lines) {
        assert.equal(line, line.trim(), `${locale}.${key}: untrimmed "${line}"`);
        assert.ok(line.length > 0, `${locale}.${key}: empty line`);
        assert.ok(line.length <= NEXT_STEP_LINE_MAX, `${locale}.${key}: "${line}" is ${line.length} chars`);
        assert.ok(!/\n/.test(line), `${locale}.${key}: multi-line`);
      }
    }
  }
});

test('the lookup is total: unknown stage, unknown locale and no stage all read as nothing', () => {
  assert.deepEqual(nextStepSuggestions('en', null), []);
  assert.deepEqual(nextStepSuggestions('en', undefined), []);
  assert.deepEqual(nextStepSuggestions('en', ''), []);
  assert.deepEqual(nextStepSuggestions('en', 'DEAL_LOST'), []);
  assert.deepEqual(nextStepSuggestions('fr', 'APPLICATION_100'), []);
  assert.equal(nextStepSuggestions('tr', 'APPLICATION_100').length, 3);
  assert.equal(nextStepSuggestions('de', 'EMPLOYED_700'), NEXT_STEP_SUGGESTIONS.de.EMPLOYED_700);
});
