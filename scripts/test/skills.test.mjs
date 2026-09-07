// Unit tests for the skill-list rule (#2314).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The incident these pin down: a mentee pasted their CV's skill list into the
// profile's single-line, comma-only skills field. The browser dropped the line
// breaks, nothing split the value and nothing bounded it, so one 300-character
// "skill" landed in `User.skills` and filled half the admin dashboard card.
//
// The two halves of the fix are both here: the splitter has to be liberal
// enough that a real paste survives it (newlines, bullets, semicolons — but NOT
// the slash inside "SQL / PostgreSQL"), and the limits have to say no in a way
// a caller can pass on to the person typing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_LIMITS,
  splitSkillInput,
  normalizeSkillName,
  skillKey,
  parseSkills,
  blockingSkillIssue,
  skillErrorBody,
  capSkills,
  clipSkillLabel,
} from '../../src/lib/skills.ts';

// The actual value from the incident, as it was pasted (newline-separated).
const PASTED_CV_LIST = `Java C# / .NET
Backend Development
REST API / API Development
SQL / PostgreSQL
Spring Boot
FastAPI Python
Generative AI / AI Tools
Power BI
Microsoft Excel
Git / GitHub
Swagger / API Testing
Entity Framework Core
Data Analysis
Database Management`;

test('the pasted CV list becomes one skill per line, slashes intact', () => {
  const skills = splitSkillInput(PASTED_CV_LIST);

  assert.equal(skills.length, 14);
  assert.equal(skills[0], 'Java C# / .NET');
  assert.equal(skills[3], 'SQL / PostgreSQL');
  assert.equal(skills.at(-1), 'Database Management');
  // Every entry is short enough to render as a badge — the whole point.
  for (const skill of skills) assert.ok(skill.length <= SKILL_LIMITS.maxSkillLength);
});

test('commas, semicolons, tabs, bullets and numbering all separate', () => {
  assert.deepEqual(splitSkillInput('React, Node; Go\tRust'), [
    'React',
    'Node',
    'Go',
    'Rust',
  ]);
  assert.deepEqual(splitSkillInput('• React\n• Node\n- Go'), ['React', 'Node', 'Go']);
  assert.deepEqual(splitSkillInput('1. React\n2) Node'), ['React', 'Node']);
  assert.deepEqual(splitSkillInput('React | Node'), ['React', 'Node']);
});

test('a separator inside parentheses belongs to the label', () => {
  assert.deepEqual(splitSkillInput('Microsoft Office (Word, Excel, PowerPoint), React'), [
    'Microsoft Office (Word, Excel, PowerPoint)',
    'React',
  ]);
});

test('an unbalanced parenthesis cannot swallow the rest of the list', () => {
  assert.deepEqual(splitSkillInput('React (hooks, Node, Go'), ['React (hooks, Node, Go']);
  assert.deepEqual(splitSkillInput('React), Node'), ['React)', 'Node']);
});

test('normalizeSkillName collapses whitespace and drops list punctuation', () => {
  assert.equal(normalizeSkillName('  Data   Analysis.  '), 'Data Analysis');
  assert.equal(normalizeSkillName('— Power BI;'), 'Power BI');
  // Case is preserved: somebody who writes React should see React.
  assert.equal(normalizeSkillName('ReAct'), 'ReAct');
});

test('duplicates fold Turkish-aware, and the first spelling is kept', () => {
  assert.equal(skillKey('Yazılım'), skillKey('yazilim'));
  assert.equal(skillKey('Doküman'), skillKey('dokuman'));

  const { skills, issues } = parseSkills('Yazılım, yazilim, React, react');
  assert.deepEqual(skills, ['Yazılım', 'React']);
  assert.equal(issues.find((i) => i.code === 'duplicate')?.count, 2);
});

test('a single field value that splits reports how many skills it became', () => {
  const { skills, issues } = parseSkills(PASTED_CV_LIST);

  assert.equal(skills.length, 14);
  assert.deepEqual(issues.find((i) => i.code === 'split'), { code: 'split', count: 14 });
});

test('an array whose elements each hold one skill reports no split notice', () => {
  const { skills, issues } = parseSkills(['React', 'Node']);

  assert.deepEqual(skills, ['React', 'Node']);
  assert.equal(issues.length, 0);
});

test('an array element a client failed to split is still split', () => {
  const { skills } = parseSkills(['React, Node', 'Go']);
  assert.deepEqual(skills, ['React', 'Node', 'Go']);
});

test('the incident value with its line breaks already lost is refused, not stored', () => {
  // What the single-line <input> actually submitted: no separator left at all.
  const spaceJoined = PASTED_CV_LIST.replace(/\n/g, ' ');
  const { skills, issues } = parseSkills(spaceJoined);

  assert.equal(skills.length, 1, 'nothing left to split on — this is the residual case');
  const blocking = blockingSkillIssue(issues);
  assert.equal(blocking?.code, 'too_long');
  assert.ok(blocking.sample.startsWith('Java C#'), 'the message can name the offender');
});

test('too many skills blocks, and reports how many over the cap', () => {
  const many = Array.from({ length: SKILL_LIMITS.maxSkills + 3 }, (_, i) => `skill-${i}`);
  const { skills, issues } = parseSkills(many);

  assert.equal(skills.length, SKILL_LIMITS.maxSkills + 3, 'parse does not truncate');
  const blocking = blockingSkillIssue(issues);
  assert.equal(blocking?.code, 'too_many');
  assert.equal(blocking.count, 3);
});

test('the refusal body carries the code, the limit and the offender', () => {
  const longOne = parseSkills('x'.repeat(200));
  const body = skillErrorBody(blockingSkillIssue(longOne.issues));
  assert.equal(body.code, 'too_long');
  assert.equal(body.limit, SKILL_LIMITS.maxSkillLength);
  assert.ok(body.sample);

  const tooMany = parseSkills(Array.from({ length: 44 }, (_, i) => `skill-${i}`));
  const manyBody = skillErrorBody(blockingSkillIssue(tooMany.issues));
  assert.equal(manyBody.code, 'too_many');
  assert.equal(manyBody.limit, SKILL_LIMITS.maxSkills);
  // Requisitions carry the same shape with their own numbers.
  assert.equal(
    skillErrorBody(blockingSkillIssue(tooMany.issues), { maxSkills: 50, maxSkillLength: 100 }).limit,
    50,
  );
});

test('a list exactly at the caps is not an issue', () => {
  const exact = Array.from({ length: SKILL_LIMITS.maxSkills }, (_, i) => `skill-${i}`);
  exact[0] = 'x'.repeat(SKILL_LIMITS.maxSkillLength);

  const { issues } = parseSkills(exact);
  assert.equal(blockingSkillIssue(issues), null);
});

test('capSkills is the lossy variant: it truncates and cuts instead of failing', () => {
  const spaceJoined = PASTED_CV_LIST.replace(/\n/g, ' ');
  const capped = capSkills(spaceJoined);

  assert.equal(capped.length, 1);
  assert.ok(capped[0].length <= SKILL_LIMITS.maxSkillLength);
  // Cut on a word boundary, so the survivor still reads as a label.
  assert.ok(!capped[0].endsWith(' '));
  assert.ok(capped[0].startsWith('Java C# / .NET Backend'));

  const many = Array.from({ length: 60 }, (_, i) => `skill-${i}`);
  assert.equal(capSkills(many).length, SKILL_LIMITS.maxSkills);
});

test('capSkills does not emit two identical entries after truncating', () => {
  const stem = 'Advanced Enterprise Distributed Systems Engineering With';
  const capped = capSkills([`${stem} Kafka`, `${stem} Kubernetes`]);

  assert.equal(new Set(capped.map(skillKey)).size, capped.length);
});

test('a long single word is truncated rather than reduced to nothing', () => {
  const [only] = capSkills('a'.repeat(120));
  assert.equal(only.length, SKILL_LIMITS.maxSkillLength);
});

test('empty, blank and null inputs are an empty list, not an entry', () => {
  assert.deepEqual(parseSkills('').skills, []);
  assert.deepEqual(parseSkills('  ,  ,\n').skills, []);
  assert.deepEqual(parseSkills(null).skills, []);
  assert.deepEqual(parseSkills(undefined).issues, []);
  // A payload with a non-string element must not become "undefined" the skill.
  assert.deepEqual(parseSkills(['React', 42, null]).skills, ['React']);
});

test('custom limits are honoured (requisitions use their own)', () => {
  const { issues } = parseSkills(['x'.repeat(80)], { maxSkills: 50, maxSkillLength: 100 });
  assert.equal(blockingSkillIssue(issues), null);
});

test('clipSkillLabel bounds a legacy row at render time', () => {
  const long = 'Java C# / .NET Backend Development REST API';
  const clipped = clipSkillLabel(long);

  assert.ok(clipped.length <= SKILL_LIMITS.labelClip);
  assert.ok(clipped.endsWith('…'));
  assert.equal(clipSkillLabel('React'), 'React');
});

// ── The deploy-script copy must agree, character for character ───────────────
// `prisma/skill-split.mjs` exists because the backfill runs as plain `node` on
// the server and cannot import TypeScript (same split as src/lib/plans.ts and
// the plan backfill, #1731). A copy nothing compares is a copy that drifts, so
// the corpus below goes through both and the two answers must match.
test('prisma/skill-split.mjs mirrors src/lib/skills.ts', async () => {
  const mirror = await import('../../prisma/skill-split.mjs');

  const CORPUS = [
    PASTED_CV_LIST,
    PASTED_CV_LIST.replace(/\n/g, ' '),
    'React, Node; Go\tRust',
    '• React\n• Node\n- Go',
    '1. React\n2) Node',
    'Microsoft Office (Word, Excel, PowerPoint), React',
    'React (hooks, Node, Go',
    'React), Node',
    '  Data   Analysis.  ',
    'Yazılım, yazilim, React, react',
    '',
    '  ,  ,\n',
    'a'.repeat(120),
    `${'Advanced Enterprise Distributed Systems Engineering With'} Kafka`,
  ];

  assert.equal(mirror.SKILL_LIMITS.maxSkills, SKILL_LIMITS.maxSkills);
  assert.equal(mirror.SKILL_LIMITS.maxSkillLength, SKILL_LIMITS.maxSkillLength);

  for (const input of CORPUS) {
    assert.deepEqual(mirror.splitSkillInput(input), splitSkillInput(input), `split: ${input.slice(0, 40)}`);
    assert.deepEqual(mirror.capSkills(input), capSkills(input), `cap: ${input.slice(0, 40)}`);
    assert.equal(mirror.skillKey(input), skillKey(input), `key: ${input.slice(0, 40)}`);
  }

  // And on the array form, where the two implementations dedupe in a different
  // order (pre- vs post-truncation) and still have to agree.
  const arrays = [
    ['React', 'Node'],
    ['React, Node', 'Go'],
    Array.from({ length: 60 }, (_, i) => `skill-${i}`),
    ['Advanced Enterprise Distributed Systems Engineering With Kafka', 'Advanced Enterprise Distributed Systems Engineering With Kubernetes'],
  ];
  for (const input of arrays) {
    assert.deepEqual(mirror.capSkills(input), capSkills(input));
  }
});
