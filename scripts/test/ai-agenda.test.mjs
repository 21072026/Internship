// The personalised session agenda (#1845): what leaves the process, and how
// the model's answer becomes agenda lines. The builder is the contract — only
// text derived from the guide, the goals the viewer may read, the previous
// session, the newest log entries and the stage goes out.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const {
  AGENDA_PROPOSAL_MAX,
  AGENDA_PROPOSAL_LINE_MAX,
  AGENDA_LOG_ENTRIES,
  agendaGoalsFor,
  agendaHasContext,
  buildAgendaPayload,
  normalizeAgendaProposal,
  templateFallback,
} = await import('../../src/lib/aiAgendaRule.ts');

const rel = { mentorId: 'mentor-1', menteeId: 'mentee-1', mentorEmail: 'mentor@example.com', menteeName: 'Ada Lovelace' };
const mentor = { id: 'mentor-1', role: 'MENTOR' };
const mentee = { id: 'mentee-1', role: 'MENTEE' };
const admin = { id: 'admin-1', role: 'ADMIN' };

// Every object carries fields that must never leave: the builder reads only
// the ones it names.
const goals = [
  { title: 'Ship the portfolio site', successCriteria: 'Deployed, three projects', progress: 40, visibility: 'PAIR', createdById: 'mentor-1', createdByRole: 'MENTOR', email: 'leak-goal@example.com' },
  { title: 'Secret plan of the mentee', successCriteria: null, progress: null, visibility: 'PRIVATE', createdById: 'mentee-1', createdByRole: 'MENTEE' },
  { title: 'Private note of the mentor', successCriteria: 'only mine', progress: null, visibility: 'PRIVATE', createdById: 'mentor-1', createdByRole: 'MENTOR' },
];
const log = [
  { date: new Date('2026-10-01T10:00:00Z'), type: 'Meeting', subject: 'Kick-off', notes: 'Agreed on a weekly call.', phone: '+49 151 0000000', cvUrl: '/cv/leak.pdf' },
  { date: new Date('2026-09-20T10:00:00Z'), type: 'Email', subject: null, notes: 'Sent the reading list.' },
];
const base = {
  locale: 'en',
  stageLabel: 'Internship in progress',
  guide: { title: 'Mid-point review', prompts: ['How is the internship going?', 'What got in the way?'] },
  existingLines: ['How is the internship going?'],
  previousLines: [{ text: 'Introduce yourselves', done: true }, { text: 'Agree on a cadence', done: false }],
  goals,
  log,
  rel,
  viewer: mentor,
};

test('the goal visibility rule decides which goals leave: a seat never sends the other seat’s PRIVATE goal', () => {
  assert.deepEqual(agendaGoalsFor(goals, rel, mentor).map((g) => g.title), ['Ship the portfolio site', 'Private note of the mentor']);
  assert.deepEqual(agendaGoalsFor(goals, rel, mentee).map((g) => g.title), ['Ship the portfolio site', 'Secret plan of the mentee']);
  // An admin reads the pair's goals, never anyone's private ones.
  assert.deepEqual(agendaGoalsFor(goals, rel, admin).map((g) => g.title), ['Ship the portfolio site']);
  const forMentor = buildAgendaPayload(base, '0123456789abcdef');
  assert.ok(forMentor.includes('Private note of the mentor'));
  assert.ok(!forMentor.includes('Secret plan of the mentee'));
  const forMentee = buildAgendaPayload({ ...base, viewer: mentee }, '0123456789abcdef');
  assert.ok(forMentee.includes('Secret plan of the mentee'));
  assert.ok(!forMentee.includes('Private note of the mentor'));
});

test('only text derived from the guide, the goals, the previous session, the log and the stage goes out — fenced', () => {
  const out = buildAgendaPayload(base, '0123456789abcdef');
  for (const expected of [
    'locale: en',
    'stage: Internship in progress',
    'guide: Mid-point review',
    '1. How is the internship going?',
    '2. What got in the way?',
    '- How is the internship going?',
    'Ship the portfolio site (40%)',
    'success: Deployed, three projects',
    '[discussed] Introduce yourselves',
    '[open] Agree on a cadence',
    '2026-10-01 · Meeting · Kick-off',
    'Agreed on a weekly call.',
    '2026-09-20 · Email',
    'Sent the reading list.',
  ]) {
    assert.ok(out.includes(expected), `payload carries: ${expected}`);
  }
  // Every person-written block is fenced as untrusted data (#2026); the fixed nonce makes it exact.
  for (const label of ['agenda', 'goals', 'previous', 'log']) {
    assert.ok(out.includes(`<<<BEGIN_UNTRUSTED_DATA id=0123456789abcdef label="${label}">>>`), `${label} is fenced`);
  }
  // Nothing the builder was not told to read.
  for (const leak of ['mentor@example.com', 'Ada Lovelace', 'leak-goal@example.com', '+49 151 0000000', '/cv/leak.pdf', 'mentor-1', 'mentee-1']) {
    assert.ok(!out.includes(leak), `payload never carries: ${leak}`);
  }
});

test('the log window is bounded and a free-form agenda says so', () => {
  const many = Array.from({ length: AGENDA_LOG_ENTRIES + 3 }, (_, i) => ({ date: new Date(2026, 0, 20 - i), type: 'Meeting', subject: `Entry ${i}`, notes: `notes ${i}` }));
  const out = buildAgendaPayload({ ...base, guide: null, log: many }, 'n');
  assert.ok(out.includes('guide: none (free-form agenda)'));
  assert.ok(out.includes(`Entry ${AGENDA_LOG_ENTRIES - 1}`));
  assert.ok(!out.includes(`Entry ${AGENDA_LOG_ENTRIES}`), 'older entries are cut');
});

test('normalizeAgendaProposal: trims, dedupes case-insensitively, drops what is already on the agenda, caps the count and the line', () => {
  const raw = ['  How is   the internship going? ', 'What got in the way?', 'what got IN the way?', '', 42, 'x'.repeat(AGENDA_PROPOSAL_LINE_MAX + 50)];
  const out = normalizeAgendaProposal(raw, ['how is the internship going?']);
  assert.deepEqual(out.slice(0, 1), ['What got in the way?']);
  assert.equal(out.length, 2);
  assert.equal(out[1].length, AGENDA_PROPOSAL_LINE_MAX);
  assert.equal(normalizeAgendaProposal(Array.from({ length: 12 }, (_, i) => `line ${i}`), []).length, AGENDA_PROPOSAL_MAX);
  assert.deepEqual(normalizeAgendaProposal('not a list', []), []);
  assert.deepEqual(normalizeAgendaProposal(null, []), []);
});

test('the honest fallback is the guide minus what the agenda already has — never empty while the guide has lines left', () => {
  assert.deepEqual(templateFallback(base.guide.prompts, base.existingLines), ['What got in the way?']);
  assert.deepEqual(templateFallback(base.guide.prompts, base.guide.prompts), []);
  assert.deepEqual(templateFallback([], []), []);
});

test('agendaHasContext: a guide, a readable goal, a previous session or a log entry is context; a hidden goal alone is not', () => {
  const empty = { guide: null, goals: [], previousLines: [], log: [], rel, viewer: mentor };
  assert.equal(agendaHasContext(empty), false);
  assert.equal(agendaHasContext({ ...empty, guide: { title: 'Kick-off', prompts: [] } }), true);
  assert.equal(agendaHasContext({ ...empty, previousLines: [{ text: 'x', done: false }] }), true);
  assert.equal(agendaHasContext({ ...empty, log: [log[0]] }), true);
  assert.equal(agendaHasContext({ ...empty, goals: [goals[0]] }), true);
  // The mentee's PRIVATE goal is no context for the mentor's call.
  assert.equal(agendaHasContext({ ...empty, goals: [goals[1]] }), false);
  assert.equal(agendaHasContext({ ...empty, goals: [goals[1]], viewer: mentee }), true);
});
