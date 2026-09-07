// Unit tests for the rate limiter's counter store (#1696).
//
// Run: npm run test:rate-limit-store  (node --test --experimental-strip-types)
//
// Three things are pinned here, because all three are invisible until the day
// they matter:
//   1. With no configuration the store is the same per-process Map it always
//      was — a single-container self-host must not change behaviour at all.
//   2. With a shared store, two processes count into ONE counter: the 6th
//      request across two replicas with a limit of 5 is refused, where today
//      each replica would grant its own five.
//   3. When the shared store is unreachable the limiter keeps working from its
//      in-memory mirror, never throws at the caller — and says so exactly once
//      rather than degrading in silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  countRequest,
  createMemoryRateLimitStore,
  createSharedRateLimitStore,
  selectRateLimitStore,
} from '../../src/lib/rateLimitStore.ts';
import { connectRedisTransport } from '../../src/lib/rateLimitRedis.ts';

const LIMIT = { limit: 5, windowMs: 60_000 };
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A Redis stand-in: one key space, the four commands the store sends. Two
 * stores pointed at the same instance are two replicas sharing one counter.
 */
function fakeRedis() {
  const keys = new Map(); // key -> { value: number, expiresAt: number }
  const backend = {
    now: 1_000_000,
    commands: [],
    fail: null,
    live(key) {
      const row = keys.get(key);
      if (!row) return null;
      if (row.expiresAt <= backend.now) {
        keys.delete(key);
        return null;
      }
      return row;
    },
    exec(command) {
      const [name, key] = command;
      switch (name) {
        case 'SET': {
          // SET key 0 PX <ttl> NX
          const ttl = Number(command[4]);
          if (backend.live(key)) return null;
          keys.set(key, { value: 0, expiresAt: backend.now + ttl });
          return 'OK';
        }
        case 'INCR': {
          const row = backend.live(key) ?? { value: 0, expiresAt: backend.now + 60_000 };
          row.value += 1;
          keys.set(key, row);
          return row.value;
        }
        case 'PTTL': {
          const row = backend.live(key);
          return row ? row.expiresAt - backend.now : -2;
        }
        case 'DEL': {
          const had = keys.has(key);
          keys.delete(key);
          return had ? 1 : 0;
        }
        default:
          throw new Error(`unexpected command ${name}`);
      }
    },
    transport() {
      return {
        pipeline: async (commands) => {
          backend.commands.push(...commands.map((c) => c.join(' ')));
          if (backend.fail) throw new Error(backend.fail);
          return commands.map(backend.exec);
        },
        close: () => {},
      };
    },
  };
  return backend;
}

function replica(backend, events) {
  return createSharedRateLimitStore({
    connect: async () => {
      if (backend.fail) throw new Error(backend.fail);
      return backend.transport();
    },
    now: () => backend.now,
    reconnectDelayMs: 0,
    onEvent: (e) => events?.push(e.type),
  });
}

test('with no store configured the limiter is the per-process map it always was', async () => {
  const { backend, store } = selectRateLimitStore({});
  assert.equal(backend, 'memory');
  assert.equal(store.status().degraded, false);

  const t0 = 1_000;
  for (let i = 1; i <= 5; i += 1) {
    assert.deepEqual(countRequest(store, 'login:1.2.3.4', LIMIT, t0), { ok: true, retryAfter: 0 });
  }
  const sixth = countRequest(store, 'login:1.2.3.4', LIMIT, t0);
  assert.equal(sixth.ok, false);
  assert.equal(sixth.retryAfter, 60, 'Retry-After is the remainder of the window, in seconds');

  // A different key is a different bucket, and the window rolls.
  assert.equal(countRequest(store, 'login:9.9.9.9', LIMIT, t0).ok, true);
  assert.equal(countRequest(store, 'login:1.2.3.4', LIMIT, t0 + 60_001).ok, true);

  // Housekeeping: expired entries are dropped on sweep, live ones are not.
  store.set('stale', { count: 3, resetAt: t0 });
  store.sweep(t0 + 1);
  assert.equal(store.get('stale'), undefined);
  assert.notEqual(store.get('login:1.2.3.4'), undefined);
});

test('an empty or non-redis URL selects memory rather than refusing to start', () => {
  assert.equal(selectRateLimitStore({ RATE_LIMIT_REDIS_URL: '   ' }).backend, 'memory');
  assert.equal(selectRateLimitStore({ RATE_LIMIT_REDIS_URL: 'localhost:6379' }).backend, 'memory');
  assert.equal(
    selectRateLimitStore({ RATE_LIMIT_REDIS_URL: 'redis://cache:6379' }).backend,
    'shared'
  );
  assert.equal(
    selectRateLimitStore({ RATE_LIMIT_REDIS_URL: 'rediss://cache:6379' }).backend,
    'shared'
  );
});

test('two replicas share one counter: the 6th request across both is refused', async () => {
  const backend = fakeRedis();
  const a = replica(backend);
  const b = replica(backend);

  // Replica A serves five requests and lets all five through.
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(countRequest(a, 'login:1.2.3.4', LIMIT, backend.now).ok, true, `hit ${i}`);
    await settle();
  }

  // Replica B has never seen this key. Its first request is the fleet's 6th:
  // it is admitted (one round trip of overshoot, documented in the store) and
  // the reply teaches B what the fleet count really is.
  assert.equal(countRequest(b, 'login:1.2.3.4', LIMIT, backend.now).ok, true);
  await settle();
  assert.equal(b.get('login:1.2.3.4').count, 6, 'B learned the shared count from the reply');

  // From here on B refuses, and so does A — one counter, not two.
  assert.equal(countRequest(b, 'login:1.2.3.4', LIMIT, backend.now).ok, false);
  await settle();
  assert.equal(countRequest(a, 'login:1.2.3.4', LIMIT, backend.now).ok, false);
  await settle();

  // Without the shared store those same requests would all have been allowed:
  // B's own memory only ever saw two of them.
  const solo = createMemoryRateLimitStore();
  assert.equal(countRequest(solo, 'login:1.2.3.4', LIMIT, backend.now).ok, true);
});

test('a successful login clears the counter on every replica, not just its own', async () => {
  const backend = fakeRedis();
  const a = replica(backend);
  const b = replica(backend);

  for (let i = 1; i <= 5; i += 1) {
    countRequest(a, 'login-fail:u@example.com', LIMIT, backend.now);
    await settle();
  }
  // The password finally verified: clearRateLimit() → store.delete().
  a.delete('login-fail:u@example.com');
  await settle();

  assert.equal(countRequest(b, 'login-fail:u@example.com', LIMIT, backend.now).ok, true);
  await settle();
  assert.equal(b.get('login-fail:u@example.com').count, 1, 'the shared counter restarted at 1');
});

test('a window that rolls locally is not resurrected by a late reply', async () => {
  const backend = fakeRedis();
  const store = replica(backend);

  countRequest(store, 'k', LIMIT, backend.now);
  await settle();
  // The window closes; the next request opens a fresh one.
  backend.now += 60_001;
  countRequest(store, 'k', LIMIT, backend.now);
  await settle();
  assert.equal(store.get('k').count, 1, 'a new window starts at 1');
});

test('an unreachable store falls back to memory, never throws, and logs once', async () => {
  const backend = fakeRedis();
  backend.fail = 'ECONNREFUSED';
  const events = [];
  const store = replica(backend, events);

  // Every one of these would have thrown at the caller if a store error could
  // propagate; instead they are counted in the mirror exactly as before.
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(countRequest(store, 'login:1.2.3.4', LIMIT, backend.now).ok, true);
    await settle();
  }
  assert.equal(countRequest(store, 'login:1.2.3.4', LIMIT, backend.now).ok, false, 'still limits');
  await settle();

  assert.deepEqual(events, ['degraded'], 'one event for the outage, not one per request');
  const status = store.status();
  assert.equal(status.backend, 'shared');
  assert.equal(status.degraded, true);
  assert.match(status.lastError, /ECONNREFUSED/);
  assert.ok(status.degradedSince, 'the operator can see how long it has been degraded');
});

test('a store that fails mid-flight degrades, and recovery is logged once', async () => {
  const backend = fakeRedis();
  const events = [];
  const store = replica(backend, events);

  countRequest(store, 'k', LIMIT, backend.now);
  await settle();
  assert.equal(store.status().degraded, false);

  backend.fail = 'connection reset';
  countRequest(store, 'k', LIMIT, backend.now);
  await settle();
  countRequest(store, 'k', LIMIT, backend.now);
  await settle();
  assert.equal(store.status().degraded, true);
  assert.deepEqual(events, ['degraded']);

  backend.fail = null;
  countRequest(store, 'k', LIMIT, backend.now);
  await settle();
  await settle();
  assert.equal(store.status().degraded, false);
  assert.equal(store.status().lastError, null);
  assert.deepEqual(events, ['degraded', 'recovered']);
});

test('a credential in the URL never reaches the reported error', async () => {
  const events = [];
  const store = createSharedRateLimitStore({
    connect: async () => {
      throw new Error('connect ECONNREFUSED for redis://user:hunter2@cache:6379/0');
    },
    reconnectDelayMs: 0,
    onEvent: (e) => events.push(e.type),
  });
  countRequest(store, 'k', LIMIT);
  await settle();
  assert.equal(store.status().lastError.includes('hunter2'), false);
  assert.match(store.status().lastError, /redis:\/\/\[redacted\]/);
});

// The transport itself, against a real socket speaking RESP — the encoder and
// the incremental parser are the parts a fake store cannot exercise.
test('the redis transport pipelines SET/INCR/PTTL over a real socket', async () => {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      // Requests are RESP arrays of bulk strings; count the commands and reply
      // in order. Split across two writes to prove the parser resumes.
      const text = chunk.toString('utf8');
      for (const line of text.split('\r\n')) if (line.startsWith('*')) seen.push(line);
      socket.write(Buffer.from('+OK\r\n:7\r'));
      setImmediate(() => socket.write(Buffer.from('\n:59000\r\n')));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const transport = await connectRedisTransport(`redis://127.0.0.1:${port}`);
    const replies = await transport.pipeline([
      ['SET', 'rl:k', '0', 'PX', '60000', 'NX'],
      ['INCR', 'rl:k'],
      ['PTTL', 'rl:k'],
    ]);
    assert.deepEqual(replies, ['OK', 7, 59000]);
    assert.equal(seen.length, 3, 'three commands went out in one write');
    transport.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a redis that never answers times out instead of hanging the caller', async () => {
  const accepted = [];
  const server = net.createServer((socket) => {
    // Accept and say nothing at all.
    accepted.push(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // The transport unrefs its socket and its timers on purpose (a counter must
  // never keep a build or a cron one-shot alive), so this test has to hold the
  // event loop open itself while it waits for the timeout to fire.
  const keepAlive = setInterval(() => {}, 10);

  try {
    const transport = await connectRedisTransport(`redis://127.0.0.1:${port}`, {
      commandTimeoutMs: 50,
    });
    await assert.rejects(() => transport.pipeline([['INCR', 'rl:k']]), /timed out/);
  } finally {
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    clearInterval(keepAlive);
  }
});
