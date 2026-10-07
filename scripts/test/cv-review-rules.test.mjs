// The scored CV review's rules (#2050): fixed sections, the band from the
// score, normalising a partial model reply, the deterministic missing skills
// for tailoring, reading prose artefacts stored before the change, the delta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { CV_SECTIONS, bandFor, normalizeReview, missingRequiredSkills, readStoredFeedback, scoreDelta, CV_REVIEW_REPLY } = await import('../../src/lib/cvReviewRules.ts');

test('the band follows the score, never the model', () => {
  assert.equal(bandFor(0), 'needs_work');
  assert.equal(bandFor(49), 'needs_work');
  assert.equal(bandFor(50), 'nearly');
  assert.equal(bandFor(74), 'nearly');
  assert.equal(bandFor(75), 'ready');
  assert.equal(bandFor(100), 'ready');
});

test('the same six sections, in the same order, whatever the model returned', () => {
  const a = normalizeReview({ score: 61.6, sections: [{ key: 'language', score: 90, findings: ['Clean'] }, { key: 'bogus', score: 10, findings: [] }] });
  const b = normalizeReview({ score: 40, sections: [] });
  assert.deepEqual(a.sections.map((s) => s.key), [...CV_SECTIONS]);
  assert.deepEqual(b.sections.map((s) => s.key), [...CV_SECTIONS]);
  assert.equal(a.score, 62);
  assert.equal(a.band, 'nearly');
  assert.deepEqual(a.sections.find((s) => s.key === 'language'), { key: 'language', score: 90, findings: ['Clean'] });
  assert.deepEqual(a.sections.find((s) => s.key === 'impact'), { key: 'impact', score: 0, findings: [] });
  assert.equal(normalizeReview({ score: 140 }).score, 100);
  assert.equal(normalizeReview({ score: -3 }).score, 0);
  assert.equal(a.tailoring, null);
});

test('checklist items are kept actionable: unknown status reads as weak, empty items drop', () => {
  const r = normalizeReview({ score: 50, checklist: [{ item: 'Add a GitHub link', status: 'missing', how_to_fix: 'Put it under your name.' }, { item: ' ', status: 'ok' }, { item: 'Quantify results', status: 'meh' }] });
  assert.deepEqual(r.checklist, [
    { item: 'Add a GitHub link', status: 'missing', howToFix: 'Put it under your name.' },
    { item: 'Quantify results', status: 'weak', howToFix: '' },
  ]);
});

test('tailoring always names the required skills the CV never mentions, de-duplicated with the model’s', () => {
  const cv = 'Built a React + TypeScript dashboard. Node.js APIs. Some C# at university.';
  const missing = missingRequiredSkills(['React', 'TypeScript', 'Kubernetes', 'PostgreSQL', 'C#', 'node.js', 'Go'], cv);
  assert.deepEqual(missing, ['Kubernetes', 'PostgreSQL', 'Go']);
  const r = normalizeReview(
    { score: 70, tailoring: { missing_skills: ['kubernetes', 'Terraform'], wording_gaps: ['Say "observability"'], emphasis: 'Lead with the dashboard.' } },
    { id: 'req1', title: 'Platform Intern', deterministicMissing: missing },
  );
  assert.deepEqual(r.tailoring, { requisitionId: 'req1', title: 'Platform Intern', missingSkills: ['Kubernetes', 'PostgreSQL', 'Go', 'Terraform'], wordingGaps: ['Say "observability"'], emphasis: 'Lead with the dashboard.' });
  assert.deepEqual(missingRequiredSkills('not a list', cv), []);
  assert.deepEqual(missingRequiredSkills(['Ünity'], 'unity games'), []);
  assert.deepEqual(missingRequiredSkills(['Go', 'Node.js'], 'I also write Go. And node.js.'), []);
});

test('a stored artefact reads back as a review, or as the prose stored before #2050', () => {
  const review = normalizeReview({ score: 80 });
  assert.deepEqual(readStoredFeedback(JSON.stringify(review)), { kind: 'review', review });
  assert.deepEqual(readStoredFeedback('**Strengths**\n- Clear'), { kind: 'prose', text: '**Strengths**\n- Clear' });
  assert.deepEqual(readStoredFeedback('{"not":"a review"}'), { kind: 'prose', text: '{"not":"a review"}' });
});

test('the delta since the previous review', () => {
  assert.equal(scoreDelta(72, 60), 12);
  assert.equal(scoreDelta(55, 60), -5);
  assert.equal(scoreDelta(60, null), null);
});

test('the reply schema accepts a partial answer', () => {
  assert.equal(CV_REVIEW_REPLY.safeParse({ score: 50 }).success, true);
  assert.equal(CV_REVIEW_REPLY.safeParse({ score: 'high' }).success, false);
});
