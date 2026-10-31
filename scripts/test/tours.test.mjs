// The in-app tour registry (#2067): every tour is fully worded in all three
// locales, and every step points at a navigation entry that exists for its
// role — a renamed nav key would otherwise silently drop the step (a missing
// target is skipped at runtime, by design).
// Run: node --test --experimental-strip-types scripts/test/tours.test.mjs (part of test:unit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOURS, firstRunTourFor, tourById, tourGuidanceKey } from '../../src/lib/tours.ts';
import { dictionaries } from '../../src/i18n/dictionaries.ts';

const LOCALES = ['en', 'tr', 'de'];
const NAV = readFileSync('src/lib/navLinks.ts', 'utf8');

test('every step of every tour has a title and body in every locale', () => {
  for (const locale of LOCALES) {
    const g = dictionaries[locale].guidance;
    for (const k of ['next', 'back', 'skip', 'done', 'progress', 'helpLabel']) assert.ok(g[k]?.trim(), `${locale}: guidance.${k}`);
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        const copy = g.tours[tour.id]?.steps?.[step.key];
        assert.ok(copy?.title?.trim() && copy?.body?.trim(), `${locale}: guidance.tours["${tour.id}"].steps.${step.key} is missing`);
      }
    }
  }
});

test('every step targets a nav entry that exists', () => {
  for (const tour of TOURS) {
    for (const step of tour.steps) {
      assert.match(step.targetId, /^nav-/, `${tour.id}: ${step.targetId} — tours point at nav entries (data-tour-id="nav-<key>")`);
      const key = step.targetId.slice('nav-'.length);
      assert.ok(NAV.includes(`key: '${key}'`), `${tour.id}: no nav link with key '${key}' in src/lib/navLinks.ts`);
    }
  }
});

test('ids are unique, one first-run tour per role, and keys are namespaced', () => {
  assert.equal(new Set(TOURS.map((t) => t.id)).size, TOURS.length);
  assert.equal(firstRunTourFor('ADMIN')?.id, 'admin-first-run');
  assert.equal(firstRunTourFor('MENTOR')?.id, 'mentor-first-run');
  assert.equal(firstRunTourFor('MENTEE'), null);
  assert.equal(tourById('nope'), null);
  assert.equal(tourGuidanceKey('admin-first-run'), 'tour:admin-first-run');
  for (const t of TOURS) assert.ok(tourGuidanceKey(t.id).length <= 191);
});
