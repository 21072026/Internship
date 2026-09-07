// Unit tests for money/percent formatting (#1730).
//
// Run: npm run test:money  (node --test --experimental-strip-types)
//
// src/lib/money.ts is the only place a currency symbol is written, which is
// what lets the pricing page satisfy "grep the page for a currency literal and
// find none". That makes every way of getting it wrong a wrong number on a
// public page, in a locale the author probably does not read:
//   • the group separator and the decimal separator are SWAPPED between en and
//     tr/de, so €1,20 in German is €120 read as English — a hundredfold error
//     that looks like a typo, not a bug;
//   • the symbol goes before the amount in en and after it in tr/de;
//   • an e2e spec pins a published annual total as a string on the rendered
//     page, so the output has to be byte-stable — this module is hand-rolled
//     rather than Intl precisely because ICU builds disagree, and a test that
//     did not pin the exact string would let that disagreement back in;
//   • and the overage rate is the one figure below a euro on the whole page,
//     so dropping its decimals prints €1 for €1.20.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCount, formatDecimal, formatEur, formatEurCents, formatPercent } from '../../src/lib/money.ts';

// The non-breaking space that keeps "1.788 €" from wrapping in a plan column.
const NBSP = ' ';

test('a whole-EUR amount is grouped and placed per locale', () => {
  assert.equal(formatEur(1788, 'en'), '€1,788');
  assert.equal(formatEur(1788, 'de'), `1.788${NBSP}€`);
  assert.equal(formatEur(1788, 'tr'), `1.788${NBSP}€`);
});

test('the published totals render correctly in all three locales', () => {
  // These are the figures a reader compares against the strategy doc.
  for (const [amount, en, other] of [
    [0, '€0', `0${NBSP}€`],
    [49, '€49', `49${NBSP}€`],
    [149, '€149', `149${NBSP}€`],
    [890, '€890', `890${NBSP}€`],
    [1188, '€1,188', `1.188${NBSP}€`],
    [4788, '€4,788', `4.788${NBSP}€`],
    [8988, '€8,988', `8.988${NBSP}€`],
  ]) {
    assert.equal(formatEur(amount, 'en'), en, `en ${amount}`);
    assert.equal(formatEur(amount, 'de'), other, `de ${amount}`);
    assert.equal(formatEur(amount, 'tr'), other, `tr ${amount}`);
  }
});

test('a whole-EUR amount never prints empty cents', () => {
  // "1.788,00 €" spends two characters saying the cents are zero.
  assert.ok(!formatEur(1788, 'de').includes(','));
  assert.ok(!formatEur(1788, 'en').includes('.00'));
});

test('grouping only kicks in above a thousand, and repeats above a million', () => {
  assert.equal(formatEur(999, 'en'), '€999');
  assert.equal(formatEur(1000, 'en'), '€1,000');
  assert.equal(formatEur(1234567, 'de'), `1.234.567${NBSP}€`);
});

test('a cent amount always keeps both decimals', () => {
  // The overage rate. €1.20 must not render as €1.2 or €1.
  assert.equal(formatEurCents(120, 'en'), '€1.20');
  assert.equal(formatEurCents(120, 'de'), `1,20${NBSP}€`);
  assert.equal(formatEurCents(120, 'tr'), `1,20${NBSP}€`);
  assert.equal(formatEurCents(80, 'en'), '€0.80');
  assert.equal(formatEurCents(80, 'tr'), `0,80${NBSP}€`);
  assert.equal(formatEurCents(5, 'en'), '€0.05');
  assert.equal(formatEurCents(100, 'de'), `1,00${NBSP}€`);
});

test('a cent amount groups its euro part too', () => {
  assert.equal(formatEurCents(123456, 'en'), '€1,234.56');
  assert.equal(formatEurCents(123456, 'de'), `1.234,56${NBSP}€`);
});

test('percent typography differs in all three locales and both others are wrong', () => {
  // tr writes the sign first, de puts a space before it, en neither.
  assert.equal(formatPercent(0.5, 'en'), '50%');
  assert.equal(formatPercent(0.5, 'tr'), '%50');
  assert.equal(formatPercent(0.5, 'de'), `50${NBSP}%`);
  assert.equal(formatPercent(0.8, 'en'), '80%');
});

test('a null count renders the caller-supplied unlimited word, not a number', () => {
  // A limit of null means unlimited. Printing "0" there would sell the
  // top tier as the emptiest one.
  assert.equal(formatCount(null, 'en', 'Unlimited'), 'Unlimited');
  assert.equal(formatCount(null, 'tr', 'Sınırsız'), 'Sınırsız');
  assert.equal(formatCount(0, 'en', 'Unlimited'), '0');
  assert.equal(formatCount(10000, 'en', 'Unlimited'), '10,000');
  assert.equal(formatCount(10000, 'de', 'Unbegrenzt'), '10.000');
  assert.equal(formatCount(25, 'tr', 'Sınırsız'), '25');
});

test('an unknown locale degrades to en rather than throwing', () => {
  // getLocale() can only return a real locale, but the formatter is exported
  // and a caller with a raw cookie value must not crash a public page.
  assert.equal(formatEur(1788, 'zz'), '€1,788');
  assert.equal(formatPercent(0.5, 'zz'), '50%');
});

test('a negative amount keeps its sign outside the digits', () => {
  // Not used on the pricing page today; pinned so a future credit line does
  // not render as "€-480" in one locale and "-480 €" in another by accident.
  assert.equal(formatEur(-480, 'en'), '€-480');
  assert.equal(formatEur(-480, 'de'), `-480${NBSP}€`);
  assert.equal(formatEurCents(-120, 'en'), '€-1.20');
});

test('a fractional month count keeps its decimal instead of being rounded', () => {
  // The bug this function exists for: 2.5 months free through formatCount()
  // rounds to 3 and overstates the annual discount by half a month.
  assert.equal(formatDecimal(2.5, 'en'), '2.5');
  assert.equal(formatDecimal(2.5, 'de'), '2,5');
  assert.equal(formatDecimal(2.5, 'tr'), '2,5');
  // A whole number prints no trailing zero — "2 months free", not "2.0".
  assert.equal(formatDecimal(2, 'en'), '2');
  assert.equal(formatDecimal(2, 'de'), '2');
  // Rounded to one decimal by default.
  assert.equal(formatDecimal(2.539, 'en'), '2.5');
  assert.equal(formatDecimal(2.04, 'en'), '2');
  assert.equal(formatDecimal(-2.5, 'de'), '-2,5');
});
