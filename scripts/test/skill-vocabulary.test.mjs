// Unit tests for the starter skill vocabulary index (#1816).
//
// `check:skills` validates the DATA (no duplicate key, no alias two skills
// claim, no dangling adjacency, all three labels present). This file pins the
// BEHAVIOUR the data exists for, which no amount of data validation implies:
//
//   • the four spellings of the same skill — "React", "react", "ReactJS",
//     "React.js" — all have to land on one key, because that failure mode is
//     the whole reason the vocabulary exists;
//   • adjacency is authored in ONE direction and must come out symmetric, or
//     "who is near React" and "who is near Frontend" would disagree depending
//     on which entry the author happened to type it under;
//   • a skill nobody curated must resolve to `null` rather than to a
//     near-miss — free text stays free text until the taxonomy work (#1819)
//     decides what to do with it.
//
// Run: npm run test:skill-vocabulary  (node --test --experimental-strip-types)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillKey } from '../../src/lib/skills.ts';
import {
  SKILL_CATEGORIES,
  SKILL_SEED,
  buildSkillIndex,
  resolveSeedEntry,
  resolveSeedKey,
  seedNeighbours,
  skillSeedLabel,
} from '../../src/lib/skillSeed.ts';

const index = buildSkillIndex(skillKey);

test('every spelling of React resolves to one key', () => {
  for (const spelling of ['React', 'react', 'REACT', 'ReactJS', 'React.js', 'React JS', ' react ']) {
    assert.equal(resolveSeedKey(index, spelling), 'react', `"${spelling}" should resolve to react`);
  }
});

test('React is adjacent to Frontend, in both directions', () => {
  assert.ok(seedNeighbours(index, 'react').includes('frontend'));
  assert.ok(seedNeighbours(index, 'frontend').includes('react'));
});

test('adjacency is symmetric and never self-referential', () => {
  for (const [key, neighbours] of index.adjacency) {
    assert.ok(!neighbours.includes(key), `${key} is adjacent to itself`);
    for (const other of neighbours) {
      assert.ok(
        (index.adjacency.get(other) ?? []).includes(key),
        `${key} → ${other} is not mirrored by ${other} → ${key}`
      );
    }
  }
});

test('Turkish and German spellings resolve too', () => {
  assert.equal(resolveSeedKey(index, 'Makine Öğrenmesi'), 'machine-learning');
  assert.equal(resolveSeedKey(index, 'makine ogrenmesi'), 'machine-learning');
  assert.equal(resolveSeedKey(index, 'Maschinelles Lernen'), 'machine-learning');
  assert.equal(resolveSeedKey(index, 'Ön Yüz Geliştirme'), 'frontend');
  assert.equal(resolveSeedKey(index, 'Çevik'), 'agile');
  assert.equal(resolveSeedKey(index, 'k8s'), 'kubernetes');
  assert.equal(resolveSeedKey(index, 'Postgres'), 'postgresql');
});

test('a skill outside the vocabulary resolves to null, not to a near miss', () => {
  assert.equal(resolveSeedKey(index, 'Reaktör Fiziği'), null);
  assert.equal(resolveSeedKey(index, 'Kaynakçılık'), null);
  assert.equal(resolveSeedEntry(index, ''), null);
});

test('every entry carries all three labels and a known category', () => {
  const categories = new Set(SKILL_CATEGORIES.map((c) => c.key));
  for (const entry of SKILL_SEED) {
    for (const locale of ['en', 'tr', 'de']) {
      assert.ok(skillSeedLabel(entry, locale).trim().length > 0, `${entry.key} has no ${locale} label`);
    }
    assert.ok(categories.has(entry.category), `${entry.key} has unknown category ${entry.category}`);
  }
});

test('the umbrella terms the matcher needs are all present', () => {
  for (const key of [
    'frontend', 'backend', 'full-stack', 'mobile', 'devops',
    'data-engineering', 'qa-testing', 'ui-ux-design', 'product-management',
  ]) {
    assert.ok(index.byKey.has(key), `missing umbrella term ${key}`);
    assert.ok(seedNeighbours(index, key).length > 0, `${key} has no neighbours, so it can never generalise`);
  }
});

test('the CV parser vocabulary is fully covered', () => {
  // src/lib/cvParse.ts matches CV text against SKILL_VOCABULARY; every term it
  // knows has to exist here, or normalising a CV suggestion would drop it.
  const cvTerms = [
    'JavaScript', 'TypeScript', 'Python', 'Java', 'C#', 'C++', 'C', 'Go', 'Rust', 'Ruby', 'PHP', 'Kotlin', 'Swift', 'Scala',
    'React', 'Next.js', 'Vue', 'Angular', 'Svelte', 'Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring', 'Spring Boot', '.NET', 'Laravel', 'Rails',
    'HTML', 'CSS', 'Tailwind', 'Sass', 'Redux', 'GraphQL', 'REST', 'tRPC',
    'SQL', 'MySQL', 'PostgreSQL', 'MariaDB', 'MongoDB', 'Redis', 'SQLite', 'Prisma', 'Elasticsearch',
    'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Terraform', 'Ansible', 'Linux', 'Nginx', 'CI/CD', 'Git', 'GitHub Actions',
    'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'scikit-learn', 'Machine Learning', 'Data Science', 'NLP',
    'Figma', 'Jira', 'Agile', 'Scrum', 'Kanban',
    'English', 'German', 'Turkish', 'French', 'Spanish',
  ];
  for (const term of cvTerms) {
    assert.ok(resolveSeedKey(index, term), `CV vocabulary term "${term}" is not in the starter vocabulary`);
  }
});
