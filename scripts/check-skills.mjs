#!/usr/bin/env node
/**
 * Guard: the starter skill vocabulary (`src/lib/skillSeed.ts`) stays honest (#1816).
 *
 * WHY THIS EXISTS
 *   The vocabulary is the thing every future skill filter, picker and match
 *   normalises *to*, and every way of breaking it is invisible to TypeScript:
 *   the types are all `string`, so a duplicated key, an alias two skills both
 *   claim, an adjacency pointing at a key somebody renamed, or a Turkish label
 *   somebody left as `''` all compile perfectly. They surface later as a picker
 *   with two "React" rows, a lookup that resolves to whichever entry happened
 *   to be first, or a blank chip in one language only — the kind of bug nobody
 *   notices until a user does.
 *
 *   `buildSkillIndex()` is deliberately tolerant of all of that (first claimant
 *   wins, unknown adjacency dropped) so a page never 500s over a typo in a data
 *   file. This check is the other half of that deal: tolerance at runtime is
 *   only safe if the data is verified in CI.
 *
 * WHAT IT CHECKS
 *   1. every entry has a non-empty labelEn / labelTr / labelDe;
 *   2. no duplicated `key`, and each key survives `skillKey()` unchanged — a
 *      key that folds to something else could never be typed and matched;
 *   3. no lookup-token collision: the key, the three labels and the aliases of
 *      one entry may not collide, after folding, with any token of another;
 *   4. no redundant alias — one that folds to its own entry's key or label (the
 *      index already holds those, so it is noise) or repeats another alias;
 *   5. no dangling / self / duplicated `adjacent` reference;
 *   6. every entry names a known category, and every category has all three
 *      labels;
 *   7. the built index round-trips: every token of every entry resolves back to
 *      that entry.
 *
 *   IDENTICAL LABELS ARE ALLOWED, deliberately: "React", "Docker" and
 *   "PostgreSQL" are the same string in all three locales, and that is correct,
 *   not a missing translation.
 *
 * Run: node --experimental-strip-types scripts/check-skills.mjs   (npm run check:skills)
 *      …scripts/check-skills.mjs <path-to-seed-module>   — run it against a
 *      fixture instead, so the guard itself can be exercised (same trick as
 *      scripts/check-stage-keys.mjs).
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { skillKey } from '../src/lib/skills.ts';
import { buildSkillIndex, skillSeedLabels } from '../src/lib/skillSeed.ts';

const SEED_MODULE = process.argv[2]
  ? pathToFileURL(path.resolve(process.argv[2])).href
  : new URL('../src/lib/skillSeed.ts', import.meta.url).href;

const { SKILL_SEED, SKILL_CATEGORIES } = await import(SEED_MODULE);

if (!Array.isArray(SKILL_SEED) || SKILL_SEED.length === 0) {
  console.error(`skills check FAILED — ${SEED_MODULE} exports no SKILL_SEED entries.`);
  process.exit(1);
}

const errors = [];
const fail = (message) => errors.push(message);

// ── Categories ───────────────────────────────────────────────────────────────
const categories = new Map();
for (const meta of SKILL_CATEGORIES ?? []) {
  if (categories.has(meta.key)) fail(`category "${meta.key}": declared twice in SKILL_CATEGORIES`);
  for (const [locale, label] of [['en', meta.labelEn], ['tr', meta.labelTr], ['de', meta.labelDe]]) {
    if (typeof label !== 'string' || label.trim() === '') {
      fail(`category "${meta.key}": missing ${locale} label`);
    }
  }
  categories.set(meta.key, meta);
}

// ── Entries ──────────────────────────────────────────────────────────────────
const KEY_SHAPE = /^[a-z0-9][a-z0-9+#.-]*$/;
// folded token → { key, field }
const claims = new Map();
const seen = new Map();

for (const entry of SKILL_SEED) {
  const key = entry.key;

  if (typeof key !== 'string' || key.trim() === '') {
    fail(`entry with label "${entry.labelEn ?? '?'}": empty key`);
    continue;
  }
  if (seen.has(key)) {
    fail(`key "${key}": duplicated — aliases and adjacency cannot point at two entries`);
    continue;
  }
  seen.set(key, entry);

  if (!KEY_SHAPE.test(key)) {
    fail(`key "${key}": must be lower-case ASCII with hyphens (matched against ${KEY_SHAPE})`);
  }
  if (skillKey(key) !== key) {
    fail(`key "${key}": does not survive skillKey() — it folds to "${skillKey(key)}", so it could never be typed and matched`);
  }

  for (const [locale, label] of [['labelEn', entry.labelEn], ['labelTr', entry.labelTr], ['labelDe', entry.labelDe]]) {
    if (typeof label !== 'string' || label.trim() === '') {
      fail(`key "${key}": ${locale} is empty — all three labels are mandatory`);
    }
  }

  if (!categories.has(entry.category)) {
    fail(`key "${key}": unknown category "${entry.category}" (known: ${[...categories.keys()].join(', ')})`);
  }

  // The entry's own tokens: key + labels first, so an alias that repeats one of
  // them is reported as redundant rather than as a collision with itself.
  const own = new Map();
  const ownToken = (raw, field) => {
    const folded = skillKey(String(raw));
    if (!own.has(folded)) own.set(folded, field);
    return folded;
  };
  ownToken(key, 'key');
  for (const [i, label] of skillSeedLabels(entry).entries()) {
    if (typeof label === 'string' && label.trim() !== '') {
      // Identical labels across locales are expected for proper nouns.
      ownToken(label, ['labelEn', 'labelTr', 'labelDe'][i]);
    }
  }

  for (const alias of entry.aliases ?? []) {
    if (typeof alias !== 'string' || alias.trim() === '') {
      fail(`key "${key}": empty alias`);
      continue;
    }
    const folded = skillKey(alias);
    if (folded === '') {
      fail(`key "${key}": alias "${alias}" folds to nothing`);
      continue;
    }
    const claimed = own.get(folded);
    if (claimed) {
      fail(
        `key "${key}": alias "${alias}" is redundant — it folds to the same token as this entry's ${claimed} ` +
          `("${folded}"), which the index already resolves`
      );
      continue;
    }
    own.set(folded, `alias "${alias}"`);
  }

  // Cross-entry collisions, once the entry's own tokens are settled.
  for (const [folded, field] of own) {
    const other = claims.get(folded);
    if (other && other.key !== key) {
      fail(
        `token "${folded}" is claimed twice: ${other.key} (${other.field}) and ${key} (${field}) — ` +
          'a lookup would silently resolve to whichever comes first'
      );
      continue;
    }
    if (!other) claims.set(folded, { key, field });
  }
}

// ── Adjacency ────────────────────────────────────────────────────────────────
for (const entry of SKILL_SEED) {
  const declared = new Set();
  for (const target of entry.adjacent ?? []) {
    if (target === entry.key) {
      fail(`key "${entry.key}": adjacent to itself`);
      continue;
    }
    if (!seen.has(target)) {
      fail(`key "${entry.key}": adjacent "${target}" is not a skill key in the vocabulary`);
      continue;
    }
    if (declared.has(target)) fail(`key "${entry.key}": adjacent "${target}" listed twice`);
    declared.add(target);
  }
}

// ── The index the app will actually use ──────────────────────────────────────
// Round-trip check: nothing above proves that what buildSkillIndex() produces
// agrees with the data it was given.
if (errors.length === 0) {
  const index = buildSkillIndex(skillKey, SKILL_SEED);
  for (const entry of SKILL_SEED) {
    for (const token of [entry.key, ...skillSeedLabels(entry), ...(entry.aliases ?? [])]) {
      const resolved = index.tokens.get(skillKey(String(token)));
      if (resolved !== entry.key) {
        fail(`key "${entry.key}": token "${token}" resolves to "${resolved ?? 'nothing'}" in the built index`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`skills check FAILED — ${errors.length} issue(s):`);
  for (const e of errors) console.error('  • ' + e);
  console.error(
    '\nThe vocabulary is the thing every skill filter normalises to, so a key is forever,\n' +
      'an alias belongs to exactly one skill, and all three labels are mandatory.\n' +
      'House style for an entry is documented at the top of src/lib/skillSeed.ts.'
  );
  process.exit(1);
}

const aliasCount = SKILL_SEED.reduce((n, e) => n + (e.aliases?.length ?? 0), 0);
const edges = SKILL_SEED.reduce((n, e) => n + (e.adjacent?.length ?? 0), 0);
console.log(
  `skills OK — ${SKILL_SEED.length} skills in ${categories.size} categories, ` +
    `${claims.size} lookup tokens (${aliasCount} aliases), ${edges} adjacency link(s), ` +
    'all with EN/TR/DE labels.'
);
