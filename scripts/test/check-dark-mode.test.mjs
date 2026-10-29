// The dark-mode guard's rule (#1614): what counts as a light surface, what the
// globals.css retint layer covers, and what counts as the element's own answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retintedUtilities, lightSurfacesWithoutDark, scanSource } from '../check-dark-mode.mjs';

const covered = retintedUtilities(readFileSync('src/app/globals.css', 'utf8'));

test('reads the retint layer from globals.css, variants included, compounds excluded', () => {
  assert.ok(covered.has('bg-white'));
  assert.ok(covered.has('bg-white/80'));
  assert.ok(covered.has('hover:bg-gray-50'));
  // `.bg-gray-100.text-gray-600` is a partial remap of a PAIR, not of text-gray-600 alone —
  // and text utilities are outside the guard anyway.
  assert.ok(!covered.has('bg-slate-50'));
});

test('a light surface outside the retint layer with no dark: answer is flagged', () => {
  assert.deepEqual(lightSurfacesWithoutDark(['rounded', 'bg-slate-50', 'p-3'], covered), ['bg-slate-50']);
  assert.deepEqual(lightSurfacesWithoutDark(['bg-zinc-200'], covered), ['bg-zinc-200']);
  assert.deepEqual(lightSurfacesWithoutDark(['bg-teal-50'], covered), ['bg-teal-50']);
  assert.deepEqual(lightSurfacesWithoutDark(['focus:bg-slate-100'], covered), ['focus:bg-slate-100']);
});

test('the retint layer, a dark: background or a dark:! pin answers it', () => {
  assert.deepEqual(lightSurfacesWithoutDark(['bg-white', 'bg-gray-50', 'bg-blue-50'], covered), []);
  assert.deepEqual(lightSurfacesWithoutDark(['bg-slate-50', 'dark:bg-gray-800'], covered), []);
  assert.deepEqual(lightSurfacesWithoutDark(['bg-zinc-200', 'dark:!bg-zinc-200'], covered), []);
  assert.deepEqual(lightSurfacesWithoutDark(['hover:bg-gray-300', 'dark:hover:bg-gray-700'], covered), []);
});

test('accent chips (*-100) and thin white highlights are not light surfaces', () => {
  assert.deepEqual(lightSurfacesWithoutDark(['bg-teal-100', 'bg-green-100'], covered), []);
  assert.deepEqual(lightSurfacesWithoutDark(['hover:bg-white/10', 'bg-white/20'], covered), []);
  assert.deepEqual(lightSurfacesWithoutDark(['bg-slate-50/60'], covered), ['bg-slate-50/60']);
});

test('one className attribute is one element, across cn() pieces and templates', () => {
  const ok = "export const A = () => <div className={cn('bg-slate-50 p-2', open && 'dark:bg-gray-800')} />;";
  assert.deepEqual(scanSource('a.tsx', ok, covered), []);
  const bad = 'export const B = ({ x }: { x: boolean }) => <div className={`p-2 ${x ? "bg-zinc-200" : ""}`} />;';
  assert.deepEqual(scanSource('b.tsx', bad, covered), [{ line: 1, utility: 'bg-zinc-200' }]);
});
