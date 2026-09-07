// Unit tests for the single-owner lease (#1701).
//
// Run: npm run test:job-lease   (node --test --experimental-strip-types)
//
// This is the module that decides whether the scheduler sends every reminder
// once or twice, so the four rules it rests on are pinned here rather than
// trusted. Each of them is invisible until the day it matters:
//
//   ACQUIRE — of two replicas starting at the same instant, exactly ONE ends up
//             the holder. Not "usually one".
//   RENEW   — the holder keeps the lease by renewing, and a renewal is
//             conditional: a process that slept past its TTL cannot renew a
//             lease that has meanwhile changed hands. That is the case where
//             two owners would both believe they hold it.
//   EXPIRE  — a replica that dies mid-hold releases NOTHING. Only the TTL
//             frees the lease, and it must free it without anyone's help.
//   STEAL   — once expired, the other replica takes over, exactly once, and the
//             generation counter records that it changed hands.
//
// Plus the two behavioural rules: losing is QUIET (false, never a throw), and a
// store that cannot be reached reads as "not the holder" so the work is skipped
// rather than duplicated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryLeaseStore,
  holdsLease,
  renewLease,
  releaseLease,
  readLease,
  leaseSnapshot,
  leaseTtlMs,
  replicaId,
  replicaName,
  setLeaseLogger,
  IMAP_BRIDGE_LEASE,
  SCHEDULER_LEASE,
} from '../../src/lib/jobs/lease.ts';

// The rules log a line on every change of ownership. Capture it instead of
// printing it, and assert on it where the log IS the behaviour ("quiet").
const logged = [];
setLeaseLogger({
  info: (message, context) => logged.push(['info', message, context]),
  warning: (message, context) => logged.push(['warning', message, context]),
  error: (message, context) => logged.push(['error', message, context]),
});
const sinceHere = () => logged.splice(0, logged.length);

const TTL = 60_000;
const NAME = IMAP_BRIDGE_LEASE;

/** A clock the test moves by hand — every rule here is about time. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('the first replica to ask becomes the holder, and the second one loses quietly', async () => {
  const store = createMemoryLeaseStore();
  const c = clock();
  sinceHere();

  assert.equal(await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now }), true);
  // No row existed, so this went through the insert path and said so once.
  assert.deepEqual(
    sinceHere().map(([level, message]) => [level, message]),
    [['info', 'Lease acquired']]
  );

  assert.equal(await holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }), false);
  // Rule 3: losing is the normal state of one of the two replicas. Nothing is
  // logged at all — not an error, not a warning.
  assert.deepEqual(sinceHere(), []);

  const row = await readLease(NAME, { store });
  assert.equal(row.holder, 'replica-1');
  assert.equal(row.generation, 1);
});

test('two replicas racing on an empty table settle on one owner, whoever wins', async () => {
  // Concurrency, not interleaving-by-luck: both calls are in flight before
  // either resolves. The memory store's insert is keyed like the primary key it
  // stands in for, so exactly one of them can create the row.
  const store = createMemoryLeaseStore();
  const c = clock();
  const [a, b] = await Promise.all([
    holdsLease(NAME, 'replica-1', TTL, { store, now: c.now }),
    holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }),
  ]);
  assert.equal(a !== b, true, 'exactly one of the two replicas must hold the lease');

  const row = await readLease(NAME, { store });
  assert.equal(row.holder, a ? 'replica-1' : 'replica-2');
});

test('the holder keeps the lease by ticking, and the tick pushes the expiry out', async () => {
  const store = createMemoryLeaseStore();
  const c = clock();
  await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now });
  const first = await readLease(NAME, { store });
  sinceHere();

  // Well inside the TTL, as a poll tick is by construction (TTL = 3 intervals).
  c.advance(TTL / 3);
  assert.equal(await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now }), true);

  const renewed = await readLease(NAME, { store });
  assert.equal(renewed.expiresAt.getTime() > first.expiresAt.getTime(), true);
  // acquiredAt is the *ownership* timestamp and a renewal must not move it —
  // "how long has this replica been the owner?" is the question it answers.
  assert.equal(renewed.acquiredAt.getTime(), first.acquiredAt.getTime());
  assert.equal(renewed.generation, 1, 'renewing is not a change of ownership');
  // A renewal is not news.
  assert.deepEqual(sinceHere(), []);
});

test('a lease nobody renews expires on its own — no release, no cleanup job', async () => {
  const store = createMemoryLeaseStore();
  const c = clock();
  await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now });

  // replica-1 is SIGKILLed here: nothing runs, nothing is released, the row
  // still says it is the holder.
  c.advance(TTL - 1);
  assert.equal(
    await holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }),
    false,
    'the lease must not be stealable one millisecond before it expires'
  );

  c.advance(2); // now past expiresAt
  sinceHere();
  assert.equal(await holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }), true);

  const row = await readLease(NAME, { store });
  assert.equal(row.holder, 'replica-2');
  assert.equal(row.generation, 2, 'a takeover is a change of ownership');
  assert.equal(row.acquiredAt.getTime(), c.now(), 'the new holder starts its own clock');
  assert.deepEqual(
    sinceHere().map(([level, message]) => [level, message]),
    [['info', 'Lease acquired']]
  );
});

test('an expired lease is taken over by exactly one of the waiting replicas', async () => {
  const store = createMemoryLeaseStore();
  const c = clock();
  await holdsLease(NAME, 'dead-replica', TTL, { store, now: c.now });
  c.advance(TTL + 1);

  const [a, b] = await Promise.all([
    holdsLease(NAME, 'replica-1', TTL, { store, now: c.now }),
    holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }),
  ]);
  assert.equal(a !== b, true, 'a takeover must not produce two holders');
  const row = await readLease(NAME, { store });
  assert.equal(row.generation, 2, 'the steal happened once, not twice');
});

test('a replica that slept past its TTL cannot renew a lease that changed hands', async () => {
  // THE two-owners case. replica-1 holds the lease, then stalls (GC pause, a
  // frozen container, a blocked event loop) for longer than the TTL. replica-2
  // legitimately takes over. When replica-1 wakes up it must NOT be able to
  // renew — if it could, both would believe they hold the lease and both would
  // poll the mailbox.
  const store = createMemoryLeaseStore();
  const c = clock();
  await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now });

  c.advance(TTL + 1);
  assert.equal(await holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }), true);

  assert.equal(
    await renewLease(NAME, 'replica-1', TTL, { store, now: c.now }),
    false,
    'the stale holder must be told it no longer holds the lease'
  );
  assert.equal(
    await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now }),
    false,
    'and it must not be able to re-take a lease that is live in someone else'
  );
  const row = await readLease(NAME, { store });
  assert.equal(row.holder, 'replica-2');
});

test('renewing an expired lease you still nominally hold fails — it must be re-acquired', async () => {
  // Same shape, without a competitor: the row still names replica-1, but the
  // lease has expired. A renewal is conditional on being LIVE, so it fails, and
  // the caller has to go through the acquire path (which bumps the generation
  // and makes the gap visible) instead of pretending nothing happened.
  const store = createMemoryLeaseStore();
  const c = clock();
  await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now });
  c.advance(TTL + 1);

  assert.equal(await renewLease(NAME, 'replica-1', TTL, { store, now: c.now }), false);
  assert.equal(await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now }), true);
  assert.equal((await readLease(NAME, { store })).generation, 2);
});

test('a graceful release hands the lease over immediately, and only the holder may release', async () => {
  const store = createMemoryLeaseStore();
  const c = clock();
  await holdsLease(NAME, 'replica-1', TTL, { store, now: c.now });

  assert.equal(
    await releaseLease(NAME, 'replica-2', { store, now: c.now }),
    false,
    'a process that does not hold the lease must not be able to free it'
  );
  assert.equal(
    await holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }),
    false,
    'and the failed release must not have shortened the real holder’s lease'
  );

  assert.equal(await releaseLease(NAME, 'replica-1', { store, now: c.now }), true);
  // No waiting out the TTL: the next replica to ask gets it.
  assert.equal(await holdsLease(NAME, 'replica-2', TTL, { store, now: c.now }), true);
  // The row is expired in place, never deleted — the history of a flapping
  // lease is the only record there is.
  const row = await readLease(NAME, { store });
  assert.equal(row.holder, 'replica-2');
  assert.equal(row.generation, 2);
});

test('leases are independent: holding the mail bridge says nothing about the scheduler', async () => {
  const store = createMemoryLeaseStore();
  const c = clock();
  assert.equal(await holdsLease(IMAP_BRIDGE_LEASE, 'replica-1', TTL, { store, now: c.now }), true);
  // The point of naming leases: the scheduler can live on the other replica, so
  // the two singletons do not have to share one process.
  assert.equal(await holdsLease(SCHEDULER_LEASE, 'replica-2', TTL, { store, now: c.now }), true);
  assert.equal(await holdsLease(SCHEDULER_LEASE, 'replica-1', TTL, { store, now: c.now }), false);
});

test('a store that cannot be reached reads as "not the holder", and says so once', async () => {
  // Rule 4. The failure direction is deliberate: a skipped reminder mails late,
  // a duplicated reminder cannot be unmailed. It must not throw at the caller
  // either — the caller is a route handler ticked by a timer.
  const broken = {
    read: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3306');
    },
    insert: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3306');
    },
    update: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:3306');
    },
  };
  sinceHere();
  assert.equal(await holdsLease(NAME, 'replica-1', TTL, { store: broken }), false);
  const lines = sinceHere();
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'error');
  // The lease name belongs in the line; a database error string must not be
  // mistaken for a lease problem, so both are present.
  assert.equal(lines[0][2].lease, NAME);
});

test('the health snapshot names the holder and says whether it is us', async () => {
  // This is what /api/health?leases=1 serves and what the multi-replica drill
  // reads. It is derived from the JobLease rows themselves — there is no second
  // record of who holds what, so the answer cannot drift from the truth.
  const store = createMemoryLeaseStore();
  const c = clock();
  const me = replicaId();
  await holdsLease(SCHEDULER_LEASE, me, TTL, { store, now: c.now });
  await holdsLease(IMAP_BRIDGE_LEASE, 'the-other-replica', TTL, { store, now: c.now });

  const snapshot = await leaseSnapshot(undefined, { store, now: c.now });
  const byName = Object.fromEntries(snapshot.map((row) => [row.name, row]));
  assert.equal(byName[SCHEDULER_LEASE].mine, true);
  assert.equal(byName[SCHEDULER_LEASE].live, true);
  assert.equal(byName[IMAP_BRIDGE_LEASE].mine, false);
  assert.equal(byName[IMAP_BRIDGE_LEASE].holder, 'the-other-replica');

  // Past the TTL both rows are still there and both read as not live — which is
  // how "nobody is running the scheduler right now" becomes visible instead of
  // being guessed from silence.
  c.advance(TTL + 1);
  const stale = await leaseSnapshot(undefined, { store, now: c.now });
  assert.deepEqual(
    stale.map((row) => row.live),
    [false, false]
  );

  // A lease no replica has ever taken has no row, and is simply absent.
  assert.deepEqual(await leaseSnapshot(['nobody-took-this'], { store, now: c.now }), []);
});

test('the TTL always leaves room for a slow tick', async () => {
  // A TTL at or below the tick interval means the holder drops its own lease
  // between ticks, which is the flapping-lease failure: both replicas take
  // turns owning the mailbox and neither keeps a connection.
  for (const intervalMs of [1_000, 30_000, 60_000, 300_000]) {
    assert.equal(leaseTtlMs(intervalMs) > intervalMs, true, `TTL must exceed ${intervalMs}ms`);
  }
  assert.equal(leaseTtlMs(60_000), 180_000);
  // Floored, so a fast tick still gets a lease long enough to survive one
  // missed round trip.
  assert.equal(leaseTtlMs(1_000), 60_000);
});

test('the replica id names the container AND the process', async () => {
  const env = { REPLICA_ID: 'internship-crm-2' };
  assert.equal(replicaName(env), 'internship-crm-2');
  const id = replicaId(env);
  assert.match(id, /^internship-crm-2#\d+$/);
  // The pid is part of it because a RESTARTED container must be a different
  // holder: the lease its previous process held has to expire rather than be
  // inherited by one that knows nothing about the work that was in flight.
  assert.equal(id.endsWith(`#${process.pid}`), true);
  // Nothing configured at all still produces a usable holder string.
  assert.match(replicaId({}), /^app#\d+$/);
  assert.equal(replicaName({ REPLICA_ID: '   ' }), 'app');
});
