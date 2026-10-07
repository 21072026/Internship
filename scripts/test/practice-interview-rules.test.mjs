// Practice interview (#2051): the bounded turn loop, the fixed rubric, the
// report normaliser — and, statically, that it is text only and the
// interviewer's tone rules are in the prompt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { readTurns, answered, isLastAnswer, transcriptText, normalizeReport, readReport, RUBRIC, PRACTICE_MAX_TURNS } = await import('../../src/lib/practiceInterviewRules.ts');

test('a stored transcript reads back defensively', () => {
  assert.deepEqual(readTurns([{ q: 'Why us?', a: 'Because', note: 'Be specific' }, { q: 'Next?' }, { a: 'orphan' }, 'junk']), [{ q: 'Why us?', a: 'Because', note: 'Be specific' }, { q: 'Next?' }]);
  assert.deepEqual(readTurns(null), []);
});

test('a session is bounded: the answer that reaches the cap ends it', () => {
  const turns = Array.from({ length: PRACTICE_MAX_TURNS }, (_, i) => ({ q: `Q${i}`, a: `A${i}` }));
  assert.equal(PRACTICE_MAX_TURNS, 6);
  assert.equal(answered(turns), 6);
  assert.equal(isLastAnswer(turns), true);
  assert.equal(isLastAnswer(turns.slice(0, 5)), false);
  assert.equal(isLastAnswer([...turns.slice(0, 5), { q: 'Q5' }]), false);
});

test('the transcript numbers questions and answers', () => {
  assert.equal(transcriptText([{ q: 'Tell me about you', a: 'I build APIs' }, { q: 'Why this role?' }]), 'Q1: Tell me about you\nA1: I build APIs\n\nQ2: Why this role?');
});

test('the report: every rubric key rated 1-5, two things to work on at most, a rewrite only when whole', () => {
  const r = normalizeReport({ ratings: { structure: 4.4, evidence: 9, relevance: 0, bogus: 3 }, went_well: ['Clear opener'], work_on: ['Use numbers', 'Shorter answers', 'Extra'], rewrite: { question: 'Q', answer: ' ' }, summary: 'Good start.' }, 'Backend Intern');
  assert.deepEqual(Object.keys(r.ratings), [...RUBRIC]);
  assert.deepEqual(r.ratings, { structure: 4, evidence: 5, relevance: 1, clarity: 1 });
  assert.deepEqual(r.workOn, ['Use numbers', 'Shorter answers']);
  assert.equal(r.rewrite, null);
  assert.equal(r.role, 'Backend Intern');
  assert.deepEqual(readReport(JSON.stringify(r)), r);
  assert.equal(readReport('prose'), null);
});

const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('text only: nothing in the feature touches a microphone, a camera or a recorder', () => {
  for (const f of ['src/components/PracticeInterview.tsx', 'src/app/api/interview-prep/session/route.ts', 'src/app/api/interview-prep/session/[id]/turn/route.ts', 'src/lib/ai/practiceInterview.ts']) {
    assert.doesNotMatch(src(f), /getUserMedia|MediaRecorder|mediaDevices|<audio|<video|SpeechRecognition/, f);
  }
});

test('the interviewer’s tone rules are in the prompt', () => {
  const s = src('src/lib/ai/practiceInterview.ts');
  for (const rule of [/never hostile/i, /accent, appearance, name, age/i, /immigration advice/i, /redirect/i]) assert.match(s, rule);
});
