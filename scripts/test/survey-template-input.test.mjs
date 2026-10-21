import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

// A built-in instrument → a survey (#1877): src/lib/surveyTemplateInput.ts.
const { surveyInputFromTemplate, allowedAudiences } = await import('../../src/lib/surveyTemplateInput.ts');
const { getSurveyTemplate, SURVEY_TEMPLATES } = await import('../../src/lib/surveyTemplates.ts');
// surveys.ts (createSurveySchema) imports Prisma; the same shape rules are
// checked here through the client-safe half they are built from.
const { isSurveyQuestionType, QUESTION_KEY_RE } = await import('../../src/lib/surveySchema.ts');

test('every built-in instrument instantiates into a valid createSurvey input, in all three languages', () => {
  for (const template of SURVEY_TEMPLATES) {
    for (const audience of allowedAudiences(template)) {
      const input = surveyInputFromTemplate(template.key, { audience });
      assert.ok(input, `${template.key} for ${audience}`);
      assert.match(input.key, QUESTION_KEY_RE);
      assert.ok(input.title.en && input.title.tr && input.title.de);
      for (const q of input.questions) {
        assert.match(q.key, QUESTION_KEY_RE);
        assert.ok(isSurveyQuestionType(q.type), `${template.key}.${q.key} type ${q.type}`);
        if (q.type === 'SELECT') assert.ok(q.options.length > 0);
      }
      for (const q of input.questions) assert.ok(q.labels.en && q.labels.tr && q.labels.de, `${template.key}.${q.key} labels`);
      assert.equal(input.templateKey, template.key);
    }
  }
});

test('an instrument with mentor wording is never one survey for both roles', () => {
  const post = getSurveyTemplate('program_post');
  assert.deepEqual(allowedAudiences(post), ['MENTEE', 'MENTOR']);
  assert.equal(surveyInputFromTemplate('program_post', { audience: 'BOTH' }), null);
  assert.deepEqual(allowedAudiences(getSurveyTemplate('nps_only')), ['MENTEE', 'MENTOR', 'BOTH']);
  assert.equal(surveyInputFromTemplate('outcome_destination', { audience: 'MENTOR' }), null);
});

test('the mentor survey carries the mentor wording; the mentee survey does not', () => {
  const mentee = surveyInputFromTemplate('program_post', { audience: 'MENTEE' });
  const mentor = surveyInputFromTemplate('program_post', { audience: 'MENTOR' });
  const label = (input) => input.questions.find((q) => q.key === 'outcome').labels.en;
  assert.notEqual(label(mentee), label(mentor));
});

test('anonymity defaults to the instrument and can be overridden; unknown keys are refused', () => {
  assert.equal(surveyInputFromTemplate('nps_only').anonymity, 'ANONYMOUS');
  assert.equal(surveyInputFromTemplate('nps_only', { anonymity: 'IDENTIFIED' }).anonymity, 'IDENTIFIED');
  assert.equal(surveyInputFromTemplate('no_such_instrument'), null);
});

test('choice questions store a value per option — the code where the template has one', () => {
  for (const template of SURVEY_TEMPLATES) {
    const input = surveyInputFromTemplate(template.key, { audience: allowedAudiences(template)[0] });
    for (const q of input.questions.filter((x) => x.type === 'SELECT')) {
      const values = q.options.map((o) => o.value);
      assert.equal(new Set(values).size, values.length, `${template.key}.${q.key} values unique`);
    }
  }
});

test('every SCALE item uses the form engine default 1..5 — a survey row stores no bounds', () => {
  for (const template of SURVEY_TEMPLATES) {
    for (const q of template.questions.filter((x) => x.type === 'SCALE')) {
      assert.deepEqual(q.scale ?? { min: 1, max: 5 }, { min: 1, max: 5 }, `${template.key}.${q.key}`);
    }
  }
});
