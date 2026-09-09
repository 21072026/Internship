// Unit tests for the starter skill vocabulary index (#1816).
//
// `check:skills` validates the DATA (no duplicate key, no alias two skills
// claim, no dangling adjacency, all three labels present). This file pins the
// BEHAVIOUR the data exists for, which no amount of data validation implies:
//
//   • the four spellings of the same skill — "React", "react", "ReactJS",
//     "React.js" — all have to land on one key, because that failure mode is
//     the whole reason the vocabulary exists;
//   • adjacency is an UNDIRECTED relation the data expresses directionally —
//     some edges are written under one entry, some under both — and it must
//     come out symmetric, or "who is near React" and "who is near Frontend"
//     would disagree depending on which entry the author happened to type it
//     under;
//   • a skill nobody curated must resolve to `null` rather than to a
//     near-miss — free text stays free text until the taxonomy work (#1819)
//     decides what to do with it.
//
// Run: npm run test:skill-vocabulary  (node --test --experimental-strip-types)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillKey } from '../../src/lib/skills.ts';
import { SKILL_VOCABULARY } from '../../src/lib/cvSkillVocabulary.ts';
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
  //
  // Read from the REAL export, never a copy. This assertion was first written
  // against a hand-typed duplicate of the 76-term list, which is a test that
  // passes forever: adding a term to the parser would not fail it, and the
  // coverage it claims to prove would quietly stop being true. That is why
  // the list moved into its own dependency-free module (cvSkillVocabulary.ts).
  assert.ok(SKILL_VOCABULARY.length > 50, 'the parser vocabulary looks truncated');
  const missing = SKILL_VOCABULARY.filter((term) => !resolveSeedKey(index, term));
  assert.deepEqual(missing, [], `CV vocabulary terms missing from the starter vocabulary: ${missing.join(', ')}`);
});

test('the verbatim lines from the real pasted CV resolve', () => {
  // These exact strings are in profile data today (skills.ts's header quotes
  // the paste). A vocabulary that cannot read back the data it was grown from
  // is not a vocabulary yet.
  const seen = {
    'REST API / API Development': 'rest',
    'SQL / PostgreSQL': 'postgresql',
    'C# / .NET': 'csharp',
    'Swagger / API Testing': 'swagger',
    'Git / GitHub': 'git',
    'Generative AI / AI Tools': 'generative-ai',
    'Power BI': 'power-bi',
    'Microsoft Excel': 'excel',
    'Entity Framework Core': 'entity-framework',
    'Data Analysis': 'data-analysis',
    'Database Management': 'database-management',
    'Backend Development': 'backend',
  };
  for (const [raw, key] of Object.entries(seen)) {
    assert.equal(resolveSeedKey(index, raw), key, `"${raw}" should resolve to ${key}`);
  }
});

test('a line naming three skills is left unresolved, not claimed by one', () => {
  // "Java C# / .NET" is one line of the pasted CV because it had no separator.
  // Aliasing it to any of the three would silently drop the other two.
  assert.equal(resolveSeedKey(index, 'Java C# / .NET'), null);
});

test('an umbrella term never resolves to one product under it', () => {
  // "NoSQL" was an alias of `mongodb`. Redis and Elasticsearch are in this
  // vocabulary and are also NoSQL stores, so that tagged a Redis engineer as a
  // MongoDB engineer — and a wrong key on a CV is worse than free text. If a
  // NoSQL umbrella entry is ever added it may own the term; a product may not.
  const resolved = resolveSeedKey(index, 'NoSQL');
  assert.ok(
    resolved === null || resolved === 'nosql',
    `"NoSQL" resolves to the product "${resolved}"`
  );
});

test('the vocabulary the checker validates is the one the app indexes', () => {
  // buildSkillIndex() defaults to SKILL_SEED; skillVocabulary.ts passes it
  // explicitly. A default that drifted from the export would make every
  // assertion in this file be about a different list than the app's.
  assert.equal(index.byKey.size, SKILL_SEED.length);
  for (const entry of SKILL_SEED) assert.ok(index.byKey.has(entry.key));
});
