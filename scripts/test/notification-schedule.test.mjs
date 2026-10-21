// Unit tests for the channel matrix, quiet hours and blackout dates (#1714).
//
// Run: npm run test:notification-schedule  (node --test --experimental-strip-types)
//
// Pinned: the matrix is sparse (absent = allowed) and only `false` turns a
// channel off; a sanitised matrix keeps known categories × channels × booleans;
// a quiet window (also one that wraps midnight) moves a delivery to the
// window's end on the recipient's clock — once, the same instant whichever
// minute inside the window it was due; blackout dates and weekends move it to
// the next open day; an all-closed calendar never holds a notification forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const R = await import('../../src/lib/notificationScheduleRule.ts');

const CATS = ['deadlines', 'messages'];
const CHS = ['inApp', 'email'];

test('matrix: sparse, only false turns a channel off', () => {
  assert.equal(R.channelPrefAllowed({}, 'deadlines', 'email'), true);
  assert.equal(R.channelPrefAllowed(null, 'deadlines', 'email'), true);
  assert.equal(R.channelPrefAllowed({ channels: 'junk' }, 'deadlines', 'email'), true);
  const prefs = { deadlines: true, channels: { deadlines: { email: false, inApp: true } } };
  assert.equal(R.channelPrefAllowed(prefs, 'deadlines', 'email'), false);
  assert.equal(R.channelPrefAllowed(prefs, 'deadlines', 'inApp'), true);
  assert.equal(R.channelPrefAllowed(prefs, 'messages', 'email'), true);
  assert.deepEqual(R.resolveChannels(prefs, 'deadlines', ['inApp', 'email']), ['inApp']);
  assert.deepEqual(R.resolveChannels({}, 'deadlines', ['inApp', 'email']), ['inApp', 'email']);
});

test('matrix: sanitised to known keys and booleans', () => {
  const out = R.sanitizeChannelMatrix(
    { deadlines: { email: false, push: false, inApp: 'yes' }, nope: { email: false }, messages: {}, __proto__: { email: false } },
    CATS,
    CHS,
  );
  assert.deepEqual(out, { deadlines: { email: false } });
  assert.deepEqual(R.sanitizeChannelMatrix(null, CATS, CHS), {});
});

test('quiet hours: parsing', () => {
  assert.deepEqual(R.parseQuietHours({ start: '21:00', end: '08:00' }), { start: '21:00', end: '08:00' });
  for (const bad of [null, {}, { start: '21:00' }, { start: '25:00', end: '08:00' }, { start: '9:00', end: '08:00' }, { start: '08:00', end: '08:00' }]) {
    assert.equal(R.parseQuietHours(bad), null);
  }
  assert.deepEqual(R.quietHoursOf({ quietHours: { start: '22:00', end: '07:30' } }), { start: '22:00', end: '07:30' });
  assert.equal(R.quietHoursOf({}), null);
  assert.equal(R.inQuietWindow(23 * 60, { start: '21:00', end: '08:00' }), true);
  assert.equal(R.inQuietWindow(2 * 60, { start: '21:00', end: '08:00' }), true);
  assert.equal(R.inQuietWindow(8 * 60, { start: '21:00', end: '08:00' }), false);
  assert.equal(R.inQuietWindow(13 * 60, { start: '12:00', end: '14:00' }), true);
  assert.equal(R.inQuietWindow(14 * 60, { start: '12:00', end: '14:00' }), false);
});

const ist = (iso) => new Date(iso); // instants written with their offset
const rules = (over = {}) => ({ quiet: { start: '21:00', end: '08:00' }, blackoutDates: [], weekends: false, tz: 'Europe/Istanbul', ...over });

test('a delivery due at 02:00 inside the window arrives at its end, on the recipient clock', () => {
  // 02:00 Istanbul (UTC+3) = 23:00 UTC the day before.
  const due = ist('2026-10-21T02:00:00+03:00');
  assert.equal(R.nextOpenInstant(due, rules()).toISOString(), '2026-10-21T05:00:00.000Z'); // 08:00 local
  // 22:30 the evening before lands on the same 08:00 — one instant, not two.
  assert.equal(R.nextOpenInstant(ist('2026-10-20T22:30:00+03:00'), rules()).toISOString(), '2026-10-21T05:00:00.000Z');
  // Open: unchanged.
  const open = ist('2026-10-21T12:00:00+03:00');
  assert.equal(R.nextOpenInstant(open, rules()).getTime(), open.getTime());
  // No rules: unchanged.
  assert.equal(R.nextOpenInstant(due, rules({ quiet: null })).getTime(), due.getTime());
});

test('a daytime window and a DST zone', () => {
  const r = rules({ quiet: { start: '12:00', end: '14:00' }, tz: 'Europe/Berlin' });
  // 2026-03-29 is the spring-forward day in Berlin (UTC+2 from 03:00).
  assert.equal(R.nextOpenInstant(ist('2026-03-29T12:30:00+02:00'), r).toISOString(), '2026-03-29T12:00:00.000Z');
  assert.equal(R.nextOpenInstant(ist('2026-01-10T12:30:00+01:00'), r).toISOString(), '2026-01-10T13:00:00.000Z');
});

test('blackout dates and weekends move to the next open day, then the quiet window applies', () => {
  // 2026-10-21 is a Wednesday. Blackout that day: next day 00:00 is quiet → 08:00 on the 22nd.
  const r = rules({ blackoutDates: ['2026-10-21'] });
  assert.equal(R.nextOpenInstant(ist('2026-10-21T12:00:00+03:00'), r).toISOString(), '2026-10-22T05:00:00.000Z');
  // Without quiet hours: midnight of the next day.
  assert.equal(
    R.nextOpenInstant(ist('2026-10-21T12:00:00+03:00'), rules({ quiet: null, blackoutDates: ['2026-10-21', '2026-10-22'] })).toISOString(),
    '2026-10-22T21:00:00.000Z',
  );
  // Saturday 2026-10-24 with weekends closed → Monday 08:00.
  assert.equal(R.nextOpenInstant(ist('2026-10-24T10:00:00+03:00'), rules({ weekends: true })).toISOString(), '2026-10-26T05:00:00.000Z');
});

test('an all-closed calendar never holds a notification forever', () => {
  const dates = [];
  for (let d = Date.parse('2026-10-21T00:00:00Z'); dates.length < 366; d += 86_400_000) dates.push(new Date(d).toISOString().slice(0, 10));
  const due = ist('2026-10-21T12:00:00+03:00');
  const out = R.nextOpenInstant(due, rules({ quiet: null, blackoutDates: dates, weekends: true }));
  // Past the listed year: the first open weekday after it — never "never".
  assert.ok(out.getTime() > due.getTime());
  assert.ok(out.getTime() < due.getTime() + 400 * 86_400_000);
});

test('blackout dates: parsing and serialising', () => {
  assert.deepEqual(R.parseBlackoutDates('2026-12-25, 2026-01-01\n2026-12-25 junk 2026-02-30 2026-13-01'), ['2026-01-01', '2026-12-25']);
  assert.deepEqual(R.parseBlackoutDates(['2026-05-01', 3, '']), ['2026-05-01']);
  assert.deepEqual(R.parseBlackoutDates(null), []);
  assert.equal(R.serializeBlackoutDates(['2026-12-25', '2026-01-01']), '2026-01-01,2026-12-25');
});
