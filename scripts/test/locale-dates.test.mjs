// Unit tests for the app-locale date/time helpers (#1422). Pure node — no
// browser, no DB.
//
// Two things are worth pinning down here, and neither is visible from a type.
//
// 1. The FORMAT has to follow the app's language, not the runtime's. The bug
//    that opened #1422 was a page rendered entirely in Turkish that printed
//    "8/25/2026", because `toLocaleDateString()` with no argument asks the
//    browser. Asserting the literal strings is the only way to catch a helper
//    that quietly drops its `locale` argument again.
// 2. A meeting time has to NAME its zone. The audience is split across Turkey
//    and Germany, so "16:30" alone is not an appointment — it is two of them
//    (#1030). `formatDateTimeWithZone` is the helper that must never lose the
//    "(GMT+3)" suffix, and it must read the instant in the zone it was given
//    rather than in whatever zone the runtime happens to be set to.
//
// Moved from e2e/locale-dates.unit.spec.ts to Node's own runner (#1598); it was
// in the @smoke set, and the unit gate runs on every PR as well.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { formatDate, formatDateTime, formatTime, formatDateTimeWithZone } = await import('../../src/lib/relativeTime.ts');
const { viewerTimeZone, zoneLabel, FALLBACK_TIMEZONE } = await import('../../src/lib/timezone.ts');

// 2026-08-25 13:30 UTC = 16:30 in Istanbul, 15:30 in Berlin, 09:30 in New York.
// A mid-afternoon instant so no zone in play crosses a date boundary and turns
// this into a calendar-arithmetic test by accident.
const INSTANT = new Date('2026-08-25T13:30:00Z');
const IST = 'Europe/Istanbul';

test('formatDate follows the app locale, not the runtime', () => {
  const opts = { timeZone: IST };
  // The exact string from the bug report: Turkish UI, US-formatted date.
  assert.equal(formatDate(INSTANT, 'tr', opts), '25.08.2026');
  assert.equal(formatDate(INSTANT, 'de', opts), '25.08.2026');
  assert.equal(formatDate(INSTANT, 'en', opts), '08/25/2026');
  // A string instant is accepted as-is, same as every existing caller passes it.
  assert.equal(formatDate(INSTANT.toISOString(), 'tr', opts), '25.08.2026');
});

test('formatDateTime keeps the locale for the time half too', () => {
  const opts = { timeZone: IST, hourCycle: 'h23' };
  assert.equal(formatDateTime(INSTANT, 'tr', opts), '25.08.2026 16:30');
  assert.equal(formatDateTime(INSTANT, 'de', opts), '25.08.2026, 16:30');
  assert.equal(formatDateTime(INSTANT, 'en', opts), '08/25/2026, 16:30');
});

test('formatTime is 24-hour in every locale', () => {
  const opts = { timeZone: IST };
  // h23 everywhere on purpose: the pickers, the meeting list and the attendee
  // readings all write "16:30", and a lone "04:30 PM" is the ambiguity the
  // whole family exists to remove.
  for (const locale of ['en', 'tr', 'de']) {
    assert.equal(formatTime(INSTANT, locale, opts), '16:30');
  }
});

test('formatDateTimeWithZone names the zone it rendered in', () => {
  assert.equal(formatDateTimeWithZone(INSTANT, 'tr', IST), '25.08.2026 16:30 (GMT+3)');
  assert.equal(formatDateTimeWithZone(INSTANT, 'de', IST), '25.08.2026, 16:30 (GMT+3)');
  assert.equal(formatDateTimeWithZone(INSTANT, 'en', IST), '08/25/2026, 16:30 (GMT+3)');
});

test('the same instant reads differently — and says so — in another zone', () => {
  // One instant, three clocks. If the label ever went missing these three would
  // be indistinguishable from three different appointments.
  assert.equal(formatDateTimeWithZone(INSTANT, 'tr', 'Europe/Berlin'), '25.08.2026 15:30 (GMT+2)');
  assert.equal(formatDateTimeWithZone(INSTANT, 'tr', 'America/New_York'), '25.08.2026 09:30 (GMT-4)');
  // UTC is spelled as an offset, not as a name: `zoneLabel` asks Intl for
  // `timeZoneName: 'shortOffset'`, which is "GMT+0" on Node's ICU and plain
  // "GMT" on some browser builds. Pin the date and the time literally — that is
  // what this file is for — and take the label from the helper, so an ICU
  // upgrade renaming a zero offset cannot turn a green suite red at 03:00 UTC.
  const utc = zoneLabel(INSTANT, 'UTC');
  assert.ok(utc);
  assert.equal(formatDateTimeWithZone(INSTANT, 'tr', 'UTC'), `25.08.2026 13:30 (${utc})`);
});

test('an unknown or missing zone falls back to the deployment default, still labelled', () => {
  // Never "whatever the runtime is set to": a label that names a zone the
  // reader is not on is still honest, a missing one is not.
  const fallback = formatDateTimeWithZone(INSTANT, 'tr', null);
  assert.equal(fallback, '25.08.2026 16:30 (GMT+3)');
  assert.equal(formatDateTimeWithZone(INSTANT, 'tr', 'Mars/Olympus_Mons'), fallback);
  assert.equal(FALLBACK_TIMEZONE, IST);
});

test('viewerTimeZone prefers the zone the user saved', () => {
  assert.equal(viewerTimeZone('Europe/Berlin'), 'Europe/Berlin');
  // Garbage in the column must not win over a real fallback.
  assert.notEqual(viewerTimeZone('not/a-zone'), 'not/a-zone');
  // With nothing saved and no browser (this runs in node), the deployment
  // default is what is left.
  assert.equal(viewerTimeZone(null), FALLBACK_TIMEZONE);
});
