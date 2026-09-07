import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// scripts/check-contrast.mjs is the cheap half of the #1299 gate: it fails a
// push on `text-white` over a solid `bg-*-N` below 4.5:1, with no browser and
// no database, so an earlier failing step cannot skip it (which is exactly how
// the landing CTA of #2284 got in).
//
// It needs its own assertions because both of its failure modes are silent.
//
// TOO NARROW. The first version matched `text-white` and the background only
// inside ONE single-line string literal. That is not how the conditional button
// is written in this tree: the white label sits in the static text of a template
// literal and the accent background in a ternary arm on the next line
// (src/components/UpcomingMeetingBanner.tsx). So the guard could not protect
// one of the very call sites it had just fixed — it printed its green check on
// `text-white` over green-500 at 2.28:1, the worst ratio in the change.
//
// TOO BROAD. The opposite mistake is worse, because a gate that cries wolf gets
// bypassed. Merging a whole className expression into one bag of classes pairs
// `text-white` from one ternary arm with `bg-gray-100` from the other and
// reports the extremely common toggle at a fictional 1.02:1 — a background that
// never sits under that label in any render.
//
// Both directions are pinned below, along with the comment-immunity the script
// depends on to explain its own fixes.

const GUARD = path.join(process.cwd(), 'scripts/check-contrast.mjs');

/** Run the guard over one throwaway file. */
function check(source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'contrast-guard-'));
  const file = path.join(dir, 'Fixture.tsx');
  try {
    writeFileSync(file, source);
    const run = spawnSync(process.execPath, [GUARD, file], { encoding: 'utf8' });
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const expectFlagged = (source, needle) => {
  const { code, out } = check(source);
  assert.equal(code, 1, `expected the guard to fail\n${out}`);
  if (needle) assert.match(out, needle);
};

const expectClean = (source) => {
  const { code, out } = check(source);
  assert.equal(code, 0, `expected the guard to pass\n${out}`);
};

test('flags white text over a too-light background on one line', () => {
  expectFlagged(
    'export const A = () => <b className="bg-red-500 text-white px-2">go</b>;\n',
    /bg-red-500.*3\.76:1/s
  );
});

test('flags a background in a ternary arm under an unconditional white label', () => {
  // THE regression this file exists for: `text-white` in the static chunk of a
  // template literal, the background one line down inside `${…}`.
  expectFlagged(
    [
      'export const A = ({ on }: { on: boolean }) => (',
      '  <a',
      '    className={`inline-flex px-4 py-2 text-sm font-medium text-white ${',
      "      on ? 'bg-green-500 hover:bg-green-600' : 'bg-blue-600 hover:bg-blue-700'",
      '    }`}',
      '  >',
      '    join',
      '  </a>',
      ');',
      '',
    ].join('\n'),
    /bg-green-500.*2\.28:1/s
  );
});

test('accepts the same shape once the surface is dark enough', () => {
  expectClean(
    [
      'export const A = ({ on }: { on: boolean }) => (',
      '  <a',
      '    className={`inline-flex px-4 py-2 text-sm font-medium text-white ${',
      "      on ? 'bg-green-700 hover:bg-green-800' : 'bg-blue-600 hover:bg-blue-700'",
      '    }`}',
      '  >',
      '    join',
      '  </a>',
      ');',
      '',
    ].join('\n')
  );
});

test('does NOT pair a white label in one ternary arm with the other arm’s background', () => {
  // The toggle/tab pattern. `text-white` applies only when `active`, and
  // `bg-gray-100` only when it is not, so the two never meet in a render.
  expectClean(
    [
      'export const A = ({ active }: { active: boolean }) => (',
      '  <button',
      '    className={`rounded px-3 py-1.5 ${',
      "      active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'",
      '    }`}',
      '  >',
      '    tab',
      '  </button>',
      ');',
      '',
    ].join('\n')
  );
});

test('flags a class map, which is not a className attribute at all', () => {
  expectFlagged(
    [
      'export const TONE = {',
      "  danger: 'bg-red-500 text-white px-2',",
      "  safe: 'bg-green-700 text-white px-2',",
      '};',
      '',
    ].join('\n'),
    /bg-red-500/
  );
});

test('sees a className that follows a URL on the same line', () => {
  // A `//` inside a string is not a comment. The stripper used to blank the
  // rest of the line from the URL onwards, and the meeting-join surfaces this
  // rule cares about are precisely the ones carrying external links.
  expectFlagged(
    'export const A = () => <a href="https://meet.google.com/x" className="bg-red-500 text-white p-1">go</a>;\n',
    /bg-red-500/
  );
});

test('ignores a bad pair quoted inside a comment', () => {
  // The fixes for this rule are explained in comments that name the class they
  // replaced. A guard that fails on its own documentation gets the
  // documentation deleted.
  expectClean(
    [
      '// Was `bg-amber-500 text-white` (2.15:1) before #1299.',
      '/* Also not code: bg-green-500 text-white. */',
      'export const A = () => <b className="bg-amber-700 text-white p-1">ok</b>;',
      '',
    ].join('\n')
  );
});

test('ignores a translucent surface, which composites against something unknown', () => {
  expectClean('export const A = () => <b className="bg-red-500/40 text-white p-1">x</b>;\n');
});

test('ignores a dark background under a label the same literal re-colours in dark', () => {
  expectClean(
    'export const A = () => <b className="bg-gray-900 text-white dark:bg-amber-500 dark:text-gray-900 p-1">x</b>;\n'
  );
});

test('reports each pair once, not once per overlapping scan', () => {
  const { code, out } = check(
    'export const A = () => <b className="bg-red-500 text-white p-1">x</b>;\n'
  );
  assert.equal(code, 1);
  assert.match(out, /1 occurrence\(s\)/);
});
