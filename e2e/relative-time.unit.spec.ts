// Unit tests for the "5 dk. önce" family: relativeTime's compact style and the
// fillTemplate helper that lets a translated sentence hold a <RelativeTime>.
// The element itself is pinned in a browser (release-notes-relative-date.spec):
// Playwright compiles the JSX of an imported .tsx into its own component-test
// objects, which react-dom cannot render here.
// Pure node — run with BASE_URL=http://localhost:9 to skip the webServer.
import { test, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { relativeTime } from '@/lib/relativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';

const NOW = new Date('2026-10-06T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('the compact style reads like "5 dk", "1 sa", "8 gün" in every locale', () => {
  const short = (d: Date, locale: string) => relativeTime(d, locale, { style: 'short', now: NOW });
  expect(short(ago(5 * MIN), 'tr')).toBe('5 dk. önce');
  expect(short(ago(HOUR), 'tr')).toBe('1 sa. önce');
  expect(short(ago(8 * DAY), 'tr')).toBe('8 gün önce');
  expect(short(ago(5 * MIN), 'en')).toBe('5 min. ago');
  expect(short(ago(HOUR), 'en')).toBe('1 hr. ago');
  expect(short(ago(5 * MIN), 'de')).toBe('vor 5 Min.');
  expect(short(ago(8 * DAY), 'de')).toBe('vor 8 Tagen');
  // The long form stays the default for the callers that never asked.
  expect(relativeTime(ago(5 * MIN), 'tr', { now: NOW })).toBe('5 dakika önce');
});

test('days run on to the month rung — no "last week" in between', () => {
  const tr = (d: Date) => relativeTime(d, 'tr', { now: NOW });
  expect(tr(ago(DAY))).toBe('dün');
  expect(tr(ago(13 * DAY))).toBe('13 gün önce');
  expect(tr(ago(29 * DAY))).toBe('29 gün önce');
  expect(tr(ago(31 * DAY))).toBe('geçen ay');
  expect(tr(ago(400 * DAY))).toBe('geçen yıl');
  // Future instants read forwards rather than as a negative distance.
  expect(relativeTime(new Date(NOW.getTime() + 3 * DAY), 'en', { now: NOW })).toBe('in 3 days');
});

test('an unparseable date renders nothing instead of throwing', () => {
  expect(relativeTime('not a date', 'tr', { now: NOW })).toBe('');
  expect(relativeTime(new Date(Number.NaN), 'en')).toBe('');
});

test('fillTemplate puts an element into a translated sentence and keeps unknown slots', () => {
  const html = renderToStaticMarkup(
    createElement(
      'p',
      null,
      fillTemplate('Son kullanım {when} · {who} · {other}', { when: createElement('b', null, 'x'), who: 'Ayşe' })
    )
  );
  expect(html).toBe('<p>Son kullanım <b>x</b> · Ayşe · {other}</p>');
});
