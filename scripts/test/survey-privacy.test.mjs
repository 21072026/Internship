// Unit tests for the survey engine's pure rules (#1879): who may read an
// individual answer (all three modes × mentor / admin / self / bystander),
// the response floor with its residual suppression, and the shared answer
// validator the survey reuses from src/lib/forms/schema.ts (#1800's shape).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { canReadIndividualResponse, applyResponseFloor, effectiveMinResponses, SURVEY_MIN_RESPONSES } = await import('../../src/lib/surveyPrivacy.ts');
const { validateResponse, canBeMatchable, FORM_FIELD_TYPES } = await import('../../src/lib/forms/schema.ts');
const { validateSurveyAnswer } = await import('../../src/lib/surveySchema.ts');

const MODES = ['IDENTIFIED', 'CONFIDENTIAL', 'ANONYMOUS'];
const self = { id: 'mentee-1', role: 'MENTEE' };
const mentor = { id: 'mentor-1', role: 'MENTOR' };
const admin = { id: 'admin-1', role: 'ADMIN' };
const otherMentor = { id: 'mentor-2', role: 'MENTOR' };
const response = (anonymity) => ({ respondentId: anonymity === 'ANONYMOUS' ? null : 'mentee-1', respondentMentorIds: ['mentor-1'] });

test('the full matrix: three modes × self, own mentor, admin, another mentor', () => {
  const expected = {
    IDENTIFIED: { self: true, mentor: false, admin: true, otherMentor: false },
    CONFIDENTIAL: { self: true, mentor: false, admin: false, otherMentor: false },
    ANONYMOUS: { self: false, mentor: false, admin: false, otherMentor: false },
  };
  for (const mode of MODES) {
    for (const [name, viewer] of Object.entries({ self, mentor, admin, otherMentor })) {
      assert.equal(canReadIndividualResponse(viewer, { anonymity: mode }, response(mode)), expected[mode][name], `${mode} / ${name}`);
    }
  }
});

test('a mentor never reads their own mentee’s answer — even holding the ADMIN role', () => {
  const adminWhoMentors = { id: 'mentor-1', role: 'ADMIN' };
  for (const mode of MODES) assert.equal(canReadIndividualResponse(adminWhoMentors, { anonymity: mode }, response(mode)), false, mode);
});

test('the floor: small buckets are hidden with their count, and so is the residual', () => {
  const out = applyResponseFloor([{ key: 'a', n: 12 }, { key: 'b', n: 7 }, { key: 'c', n: 3 }]);
  assert.deepEqual(out.map((b) => [b.key, b.suppressed]), [['a', false], ['b', true], ['c', true]]);
  assert.equal('n' in out[2], false, 'a suppressed bucket carries no count');
  // Two small buckets already protect each other: nothing extra is hidden.
  assert.deepEqual(applyResponseFloor([{ key: 'a', n: 20 }, { key: 'b', n: 2 }, { key: 'c', n: 1 }]).map((b) => b.suppressed), [false, true, true]);
  // An "everyone else" bucket gets no exemption.
  assert.equal(applyResponseFloor([{ key: 'cohort-x', n: 9 }, { key: 'everyone-else', n: 4 }]).every((b) => b.suppressed), true);
  // Nothing small: everything shown.
  assert.equal(applyResponseFloor([{ key: 'a', n: 5 }, { key: 'b', n: 6 }]).some((b) => b.suppressed), false);
});

test('a survey may raise the floor, never lower it', () => {
  assert.equal(effectiveMinResponses(undefined), SURVEY_MIN_RESPONSES);
  assert.equal(effectiveMinResponses(2), SURVEY_MIN_RESPONSES);
  assert.equal(effectiveMinResponses(10), 10);
  assert.equal(applyResponseFloor([{ key: 'a', n: 8 }, { key: 'b', n: 9 }], 10).every((b) => b.suppressed), true);
});

test('validateResponse, one case per field type', () => {
  const opts = [{ value: 'x', labels: { en: 'X' } }, { value: 'y', labels: { en: 'Y' } }];
  assert.equal(validateResponse({ key: 'k', type: 'TEXT', required: true }, ''), 'required');
  assert.equal(validateResponse({ key: 'k', type: 'TEXT' }, ''), null);
  assert.equal(validateResponse({ key: 'k', type: 'TEXT' }, 'a'.repeat(501)), 'too_long');
  assert.equal(validateResponse({ key: 'k', type: 'LONG_TEXT' }, 'a'.repeat(4000)), null);
  assert.equal(validateResponse({ key: 'k', type: 'SELECT', options: opts }, 'z'), 'not_an_option');
  assert.equal(validateResponse({ key: 'k', type: 'MULTI_SELECT', options: opts }, ['x', 'y']), null);
  assert.equal(validateResponse({ key: 'k', type: 'MULTI_SELECT', options: opts }, ['x', 'x']), 'not_an_option');
  assert.equal(validateResponse({ key: 'k', type: 'NUMBER' }, '3'), 'invalid_type');
  assert.equal(validateResponse({ key: 'k', type: 'BOOLEAN' }, false), null);
  assert.equal(validateResponse({ key: 'k', type: 'DATE' }, '2026-02-30x'), 'invalid_date');
  assert.equal(validateResponse({ key: 'k', type: 'SCALE' }, 6), 'out_of_range');
  assert.equal(validateResponse({ key: 'k', type: 'SCALE' }, 3), null);
  assert.equal(FORM_FIELD_TYPES.length, 8);
});

test('NPS is a 0..10 scale through the same validator; free text is never matchable', () => {
  assert.equal(validateSurveyAnswer({ key: 'nps', type: 'NPS', required: true }, 0), null);
  assert.equal(validateSurveyAnswer({ key: 'nps', type: 'NPS' }, 11), 'out_of_range');
  assert.equal(validateSurveyAnswer({ key: 'nps', type: 'NPS' }, 7.5), 'invalid_type');
  assert.equal(canBeMatchable({ type: 'TEXT' }), false);
  assert.equal(canBeMatchable({ type: 'LONG_TEXT' }), false);
  assert.equal(canBeMatchable({ type: 'SCALE' }), true);
});
