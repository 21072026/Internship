// Unit tests for the "5 dk. önce" family: relativeTime's compact style and the
// fillTemplate helper that lets a translated sentence hold a <RelativeTime>.
// The element itself is pinned in a browser (release-notes-relative-date.spec):
// Playwright compiles the JSX of an imported .tsx into its own component-test
// objects, which react-dom cannot render here.
//
// Moved from e2e/relative-time.unit.spec.ts to Node's own runner (#1598), so
// relativeTime.ts is measured by the coverage floor (scripts/check-unit-coverage.mjs).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { relativeTime } = await import('../../src/lib/relativeTime.ts');
const { fillTemplate } = await import('../../src/components/ui/fillTemplate.ts');

const NOW = new Date('2026-10-06T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('the compact style reads like "5 dk", "1 sa", "8 gün" in every locale', () => {
  const short = (d, locale) => relativeTime(d, locale, { style: 'short', now: NOW });
  assert.equal(short(ago(5 * MIN), 'tr'), '5 dk. önce');
  assert.equal(short(ago(HOUR), 'tr'), '1 sa. önce');
  assert.equal(short(ago(8 * DAY), 'tr'), '8 gün önce');
  assert.equal(short(ago(5 * MIN), 'en'), '5 min. ago');
  assert.equal(short(ago(HOUR), 'en'), '1 hr. ago');
  assert.equal(short(ago(5 * MIN), 'de'), 'vor 5 Min.');
  assert.equal(short(ago(8 * DAY), 'de'), 'vor 8 Tagen');
  // The long form stays the default for the callers that never asked.
  assert.equal(relativeTime(ago(5 * MIN), 'tr', { now: NOW }), '5 dakika önce');
});

test('days run on to the month rung — no "last week" in between', () => {
  const tr = (d) => relativeTime(d, 'tr', { now: NOW });
  assert.equal(tr(ago(DAY)), 'dün');
  assert.equal(tr(ago(13 * DAY)), '13 gün önce');
  assert.equal(tr(ago(29 * DAY)), '29 gün önce');
  assert.equal(tr(ago(31 * DAY)), 'geçen ay');
  assert.equal(tr(ago(400 * DAY)), 'geçen yıl');
  // Future instants read forwards rather than as a negative distance.
  assert.equal(relativeTime(new Date(NOW.getTime() + 3 * DAY), 'en', { now: NOW }), 'in 3 days');
});

test('an unparseable date renders nothing instead of throwing', () => {
  assert.equal(relativeTime('not a date', 'tr', { now: NOW }), '');
  assert.equal(relativeTime(new Date(Number.NaN), 'en'), '');
});

test('fillTemplate puts an element into a translated sentence and keeps unknown slots', () => {
  const html = renderToStaticMarkup(
    createElement(
      'p',
      null,
      fillTemplate('Son kullanım {when} · {who} · {other}', { when: createElement('b', null, 'x'), who: 'Ayşe' })
    )
  );
  assert.equal(html, '<p>Son kullanım <b>x</b> · Ayşe · {other}</p>');
});
