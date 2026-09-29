// Unit tests for the read access log's repeat-view rule (#2433).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// WHAT THIS PINS
//   "Who read this company?" is answered from ActivityLog `company.view` rows
//   (GET /api/companies/[id]). Three properties decide whether that answer can
//   be trusted, and none of them is visible from the route:
//
//   1. A repeat of the same read inside the window writes ONE row, and a read
//      after the window writes another: the log is de-noised, not silenced.
//   2. No setting value can turn the log off. `0` means "log every read"; a
//      blank or corrupted value falls back to the default, never to "suppress".
//   3. No failure reaches the page. A failed setting read, lookup or write
//      still returns an outcome, and a failed lookup RECORDS the view.
//   4. The row names the REAL reader: behind an impersonated session that is
//      the admin, "as" the user, never the user who did not read anything.
//
//   Plus the one that silently lost rows elsewhere (#1268): `detail` is a
//   VARCHAR(191), and an oversized value drops the whole insert.
//
// The rule module is dependency-free, so it is imported directly. Nothing here
// touches a database: the ledger below is an array with a clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_DETAIL_MAX,
  VIEW_LOG_WINDOW_DEFAULT_MINUTES,
  VIEW_LOG_WINDOW_MAX_MINUTES,
  attributeView,
  parseViewLogWindowMinutes,
  recordViewOnce,
  viewLogWindowStart,
} from '../../src/lib/viewLogRule.ts';

const MIN = 60_000;
const T0 = new Date('2026-09-28T10:00:00.000Z');

// An in-memory stand-in for the ActivityLog rows of ONE (action, actor, target,
// detail, ip) key, the same comparison logViewActivity() makes in SQL.
function ledger(windowMinutes = async () => 15) {
  const rows = [];
  let clock = T0;
  const calls = { hasRecent: 0 };
  return {
    rows,
    calls,
    at(date) {
      clock = date;
    },
    view() {
      return recordViewOnce({
        now: () => clock,
        windowMinutes,
        hasRecent: async (since) => {
          calls.hasRecent += 1;
          return rows.some((r) => r.createdAt >= since);
        },
        write: async () => {
          rows.push({ createdAt: clock });
        },
      });
    },
  };
}

// ── The setting ─────────────────────────────────────────────────────────────

test('the window setting: digits are minutes, 0 means "log every read"', () => {
  assert.equal(parseViewLogWindowMinutes('15'), 15);
  assert.equal(parseViewLogWindowMinutes('1'), 1);
  assert.equal(parseViewLogWindowMinutes(' 30 '), 30);
  assert.equal(parseViewLogWindowMinutes('0'), 0);
});

test('a blank or broken setting falls back to the default, never to "suppress everything"', () => {
  for (const raw of [undefined, null, '', '   ', '-5', 'abc', '1.5', '15m', '1e3', 'Infinity']) {
    assert.equal(parseViewLogWindowMinutes(raw), VIEW_LOG_WINDOW_DEFAULT_MINUTES, `raw=${JSON.stringify(raw)}`);
  }
  assert.equal(VIEW_LOG_WINDOW_DEFAULT_MINUTES, 15);
});

test('a window longer than a day is clamped to a day', () => {
  assert.equal(parseViewLogWindowMinutes('1440'), VIEW_LOG_WINDOW_MAX_MINUTES);
  assert.equal(parseViewLogWindowMinutes('9999'), VIEW_LOG_WINDOW_MAX_MINUTES);
  assert.equal(parseViewLogWindowMinutes('999999999'), VIEW_LOG_WINDOW_MAX_MINUTES);
  assert.equal(VIEW_LOG_WINDOW_MAX_MINUTES, 24 * 60);
});

test('the window start is `now - window`, and there is none when suppression is off', () => {
  assert.equal(viewLogWindowStart(T0, 15).toISOString(), '2026-09-28T09:45:00.000Z');
  assert.equal(viewLogWindowStart(T0, 0), null);
  assert.equal(viewLogWindowStart(T0, -1), null);
  assert.equal(viewLogWindowStart(T0, Number.NaN), null);
});

// ── Suppression ─────────────────────────────────────────────────────────────

test('the first read is recorded; a repeat inside the window is not', async () => {
  const l = ledger();
  assert.equal(await l.view(), 'recorded');
  l.at(new Date(T0.getTime() + 1_000));
  assert.equal(await l.view(), 'suppressed');
  l.at(new Date(T0.getTime() + 14 * MIN));
  assert.equal(await l.view(), 'suppressed');
  assert.equal(l.rows.length, 1);
});

test('a read after the window is a new row, and it opens a new window', async () => {
  const l = ledger();
  await l.view();
  l.at(new Date(T0.getTime() + 15 * MIN + 1));
  assert.equal(await l.view(), 'recorded');
  l.at(new Date(T0.getTime() + 20 * MIN));
  assert.equal(await l.view(), 'suppressed', 'measured from the most recent row, not the first');
  assert.equal(l.rows.length, 2);
});

test('the boundary: exactly `window` minutes later is still a repeat', async () => {
  // `createdAt >= since`, the same comparison the Prisma query makes.
  const l = ledger();
  await l.view();
  l.at(new Date(T0.getTime() + 15 * MIN));
  assert.equal(await l.view(), 'suppressed');
});

test('window 0 records every read and never runs the lookup', async () => {
  const l = ledger(async () => 0);
  assert.equal(await l.view(), 'recorded');
  assert.equal(await l.view(), 'recorded');
  assert.equal(await l.view(), 'recorded');
  assert.equal(l.rows.length, 3);
  assert.equal(l.calls.hasRecent, 0);
});

// ── Failure never reaches the page ──────────────────────────────────────────

test('a failed setting read uses the default window', async () => {
  const l = ledger(async () => {
    throw new Error('settings table unreachable');
  });
  assert.equal(await l.view(), 'recorded');
  l.at(new Date(T0.getTime() + (VIEW_LOG_WINDOW_DEFAULT_MINUTES - 1) * MIN));
  assert.equal(await l.view(), 'suppressed');
  l.at(new Date(T0.getTime() + (VIEW_LOG_WINDOW_DEFAULT_MINUTES + 1) * MIN));
  assert.equal(await l.view(), 'recorded');
});

test('a failed lookup RECORDS the view: a duplicate is cheaper than a missing read', async () => {
  const written = [];
  const outcome = await recordViewOnce({
    now: () => T0,
    windowMinutes: async () => 15,
    hasRecent: async () => {
      throw new Error('deadlock');
    },
    write: async () => {
      written.push(T0);
    },
  });
  assert.equal(outcome, 'recorded');
  assert.equal(written.length, 1);
});

test('a failed write is reported, never thrown', async () => {
  const outcome = await recordViewOnce({
    windowMinutes: async () => 15,
    hasRecent: async () => false,
    write: async () => {
      throw new Error('P2000');
    },
  });
  assert.equal(outcome, 'failed');
});

test('without an injected clock the rule reads the real one', async () => {
  let since = null;
  const before = Date.now();
  await recordViewOnce({
    windowMinutes: async () => 15,
    hasRecent: async (s) => {
      since = s;
      return false;
    },
    write: async () => {},
  });
  assert.ok(Math.abs(since.getTime() - (before - 15 * MIN)) < 5_000, since.toISOString());
});

// ── Attribution: the REAL reader ────────────────────────────────────────────

const USER = 'cuser00000000000000000000';
const ADMIN = 'cadmin0000000000000000000';

test('an ordinary read is the session user\'s, and carries no detail at all', () => {
  assert.deepEqual(attributeView({ id: USER, email: 'mentor@demo.example.com' }), {
    actorId: USER,
    actorEmail: 'mentor@demo.example.com',
    detail: null,
  });
  // A missing e-mail is a null column, not the string "undefined".
  assert.deepEqual(attributeView({ id: USER }), { actorId: USER, actorEmail: null, detail: null });
  assert.deepEqual(attributeView({ id: USER, email: null, impersonatorId: null }), {
    actorId: USER,
    actorEmail: null,
    detail: null,
  });
});

test('a read through an impersonated session is the ADMIN\'s, "as" the user', () => {
  // The session is the user's; the eyes are the admin's. Same convention as
  // impersonate.stop (actorId: impersonatorId, the user as the object).
  const read = attributeView(
    { id: USER, email: 'mentor@demo.example.com', impersonatorId: ADMIN },
    'admin@demo.example.com'
  );
  assert.deepEqual(read, { actorId: ADMIN, actorEmail: 'admin@demo.example.com', detail: `as ${USER}` });
  // The user's e-mail must not end up as the actor's: a search of the feed by
  // the user's address would otherwise find a read they never made.
  assert.notEqual(read.actorEmail, 'mentor@demo.example.com');
});

test('an impersonated read whose admin e-mail could not be looked up still names the admin', () => {
  assert.deepEqual(attributeView({ id: USER, email: 'mentor@demo.example.com', impersonatorId: ADMIN }), {
    actorId: ADMIN,
    actorEmail: null,
    detail: `as ${USER}`,
  });
});

test('an admin\'s own read and their read through an impersonated account are different repeat keys', () => {
  // Same actor, same target: only `detail` keeps the two apart, so the one
  // made through somebody else's session is never folded into the other.
  const own = attributeView({ id: ADMIN, email: 'admin@demo.example.com' });
  const asUser = attributeView({ id: USER, impersonatorId: ADMIN }, 'admin@demo.example.com');
  assert.equal(own.actorId, asUser.actorId);
  assert.notEqual(own.detail, asUser.detail);
});

test('detail never exceeds the VARCHAR(191) column', () => {
  assert.equal(ACTIVITY_DETAIL_MAX, 191);
  const odd = attributeView({ id: 'x'.repeat(500), impersonatorId: ADMIN });
  assert.equal(odd.detail.length, ACTIVITY_DETAIL_MAX);
  assert.ok(odd.detail.startsWith('as x'), odd.detail);
});
