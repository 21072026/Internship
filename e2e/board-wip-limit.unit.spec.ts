import { test, expect } from '@playwright/test';
import {
  DEFAULT_BOARD_WIP_LIMIT,
  WIP_SATURATION_MIN_COLUMNS,
  isOverWipLimit,
  isWipSaturated,
  parseStageWipLimit,
  resolveOrgWipLimit,
  resolveWipLimit,
} from '@/lib/boardWip';

// Board WIP limits (#1439) — the rule alone, no browser and no database.
//
// The bug this replaces was a hardcoded `WIP_LIMIT = 8`: at 308 relations all
// thirteen columns read "24 / 8" and the amber chip stopped saying anything. The
// three things that must not regress are all decidable here — a limit resolves
// per stage, "off" is reachable at both levels, and a board where everything
// breaches is recognised as such.

test('the shipped default is the number the board had, so nothing moves on deploy', async () => {
  expect(DEFAULT_BOARD_WIP_LIMIT).toBe(8);
  expect(resolveOrgWipLimit(undefined)).toBe(8);
  expect(resolveOrgWipLimit('')).toBe(8);
  // A corrupted row falls back to the default rather than silently switching
  // off a signal the operator believes is on.
  expect(resolveOrgWipLimit('not a number')).toBe(8);
  expect(resolveWipLimit('APPLICATION_100', resolveOrgWipLimit(null), {})).toBe(8);
});

test('an org can switch the warnings off entirely', async () => {
  expect(resolveOrgWipLimit('0')).toBeNull();
  expect(resolveOrgWipLimit('-4')).toBeNull();
  // …and then no column can be over the limit, however deep it is.
  expect(resolveWipLimit('APPLICATION_100', resolveOrgWipLimit('0'), {})).toBeNull();
  expect(isOverWipLimit({ status: 'APPLICATION_100', count: 900, limit: null })).toBe(false);
});

test('a per-stage limit wins over the org number, and 0 means never warn here', async () => {
  const org = resolveOrgWipLimit('25');
  expect(resolveWipLimit('a', org, { a: 60 })).toBe(60);
  // Not configured → inherit. Clearing the field stores nothing, so this is
  // also what "give this stage back to the org number" looks like.
  expect(resolveWipLimit('b', org, { a: 60 })).toBe(25);
  expect(resolveWipLimit('b', org, { b: null })).toBe(25);
  // An explicit 0 is a statement, not a missing value: a first-contact column
  // is supposed to be deep and nobody should be warned about it.
  expect(resolveWipLimit('c', org, { c: 0 })).toBeNull();
  // A stage that opts out stays opted out even when the org number is low.
  expect(resolveWipLimit('c', resolveOrgWipLimit('5'), { c: 0 })).toBeNull();
  // Typed input arrives as a string from the form.
  expect(parseStageWipLimit('12')).toBe(12);
  expect(parseStageWipLimit('')).toBeNull();
  expect(parseStageWipLimit('0')).toBe(0);
  // A negative cannot mean anything but "off" — it must not fall through to the
  // org default, because somebody typed a number rather than clearing the box.
  expect(parseStageWipLimit('-3')).toBe(0);
});

test('a column is over its limit only when it is strictly above it', async () => {
  expect(isOverWipLimit({ status: 'a', count: 8, limit: 8 })).toBe(false);
  expect(isOverWipLimit({ status: 'a', count: 9, limit: 8 })).toBe(true);
  expect(isOverWipLimit({ status: 'a', count: 0, limit: 0 })).toBe(false);
});

test('a board where every column breaches is treated as unwarned, not all-amber', async () => {
  // The measured board from the issue: thirteen columns, all of them over 8.
  const all = Array.from({ length: 13 }, (_, i) => ({ status: `s${i}`, count: 20 + i, limit: 8 }));
  expect(isWipSaturated(all)).toBe(true);

  // Two of thirteen over the limit is the signal the chip exists for — those
  // two are where the work sits, and the warning must survive.
  const twoStuck = all.map((c, i) => (i < 2 ? c : { ...c, count: 3 }));
  expect(isWipSaturated(twoStuck)).toBe(false);

  // Empty columns are not evidence either way, and a board too small to
  // compare anything is never called saturated.
  expect(isWipSaturated([{ status: 'a', count: 9, limit: 8 }])).toBe(false);
  expect(
    isWipSaturated([
      { status: 'a', count: 9, limit: 8 },
      { status: 'b', count: 0, limit: 8 },
      { status: 'c', count: 0, limit: 8 },
    ])
  ).toBe(false);
  expect(WIP_SATURATION_MIN_COLUMNS).toBe(3);

  // Stages with no limit sit outside the judgement entirely: an org that opted
  // three columns out has not thereby made the rest meaningless.
  expect(
    isWipSaturated([
      { status: 'a', count: 99, limit: null },
      { status: 'b', count: 99, limit: null },
      { status: 'c', count: 9, limit: 8 },
    ])
  ).toBe(false);
});
