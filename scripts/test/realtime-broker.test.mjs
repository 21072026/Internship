// The cross-replica realtime bus (#1698): the envelope rules, the Redis
// pub/sub transport against a real socket, and the bus delivering a peer
// replica's publish to its own listener — with no broker configured as the
// unchanged default.
//
// The "Redis" here is a ~40-line RESP server (AUTH, SELECT, SUBSCRIBE, PUBLISH)
// on 127.0.0.1, the same approach rate-limit-store.test.mjs takes: real
// sockets, real framing, no dependency.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { encodeCommand, parseReply } = await import('../../src/lib/rateLimitRedis.ts');
const rule = await import('../../src/lib/realtimeBrokerRule.ts');
const { startRealtimeBroker } = await import('../../src/lib/realtimeBroker.ts');

// ── A tiny pub/sub server ────────────────────────────────────────────────────
function bulk(s) {
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}
function startServer({ password } = {}) {
  const subscribers = new Map(); // channel -> Set<socket>
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let authed = !password;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = parseReply(buf, 0);
        if (!r) return;
        buf = buf.subarray(r.next);
        const [cmd, ...args] = r.value;
        const c = String(cmd).toUpperCase();
        if (c === 'AUTH') {
          authed = args.at(-1) === password;
          socket.write(authed ? '+OK\r\n' : '-WRONGPASS invalid password\r\n');
        } else if (!authed) socket.write('-NOAUTH Authentication required\r\n');
        else if (c === 'SELECT') socket.write('+OK\r\n');
        else if (c === 'SUBSCRIBE') {
          const set = subscribers.get(args[0]) ?? new Set();
          set.add(socket);
          subscribers.set(args[0], set);
          socket.write(`*3\r\n${bulk('subscribe')}${bulk(args[0])}:1\r\n`);
        } else if (c === 'PUBLISH') {
          const set = subscribers.get(args[0]) ?? new Set();
          for (const s of set) s.write(`*3\r\n${bulk('message')}${bulk(args[0])}${bulk(args[1])}`);
          socket.write(`:${set.size}\r\n`);
        }
      }
    });
    socket.on('close', () => {
      sockets.delete(socket);
      for (const set of subscribers.values()) set.delete(socket);
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        dropAll: () => sockets.forEach((s) => s.destroy()),
        close: () => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(r))),
      })
    )
  );
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const quiet = { warning: () => {}, info: () => {} };
const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

// ── The envelope ─────────────────────────────────────────────────────────────
test('only the signal crosses: unknown keys (a body, a name) are dropped, unknown types refused', () => {
  const ev = rule.sanitizeEvent({ type: 'message', conversationId: 'c1', body: 'secret text', senderName: 'Ada' });
  assert.deepEqual(ev, { type: 'message', conversationId: 'c1' });
  assert.equal(rule.sanitizeEvent({ type: 'chat', conversationId: 'c1' }), null);
  assert.deepEqual(rule.sanitizeEvent({ type: 'read', relationId: 'x'.repeat(65), senderId: null }), { type: 'read', senderId: null });
});

test('encode → decode round-trips, and a tampered or oversized payload decodes to null', () => {
  const wire = rule.encodeEnvelope('rA', ['u1', 'u1', 'u2'], { type: 'notification', body: 'nope' });
  assert.deepEqual(JSON.parse(wire), { o: 'rA', u: ['u1', 'u2'], e: { type: 'notification' } });
  assert.deepEqual(rule.decodeEnvelope(wire), { o: 'rA', u: ['u1', 'u2'], e: { type: 'notification' } });
  assert.equal(rule.encodeEnvelope('rA', [], { type: 'message' }), null);
  assert.equal(rule.encodeEnvelope('rA', ['u1'], { type: 'bogus' }), null);
  assert.equal(rule.decodeEnvelope('not json'), null);
  assert.equal(rule.decodeEnvelope(JSON.stringify({ o: 'rA', u: ['u1'], e: { type: 'evil' } })), null);
  assert.equal(rule.decodeEnvelope(JSON.stringify({ o: 'bad origin!', u: ['u1'], e: { type: 'read' } })), null);
  assert.equal(rule.decodeEnvelope('x'.repeat(70_000)), null);
  const many = Array.from({ length: 600 }, (_, i) => `u${i}`);
  assert.equal(rule.decodeEnvelope(rule.encodeEnvelope('rA', many, { type: 'read' })).u.length, rule.MAX_RECIPIENTS);
});

test('the channel is scoped per deployment, so a shared Redis never crosses prod and preview', () => {
  assert.equal(rule.realtimeChannel({ NEXTAUTH_URL: 'https://app.example.test' }), 'realtime:app.example.test');
  assert.equal(rule.realtimeChannel({ NEXTAUTH_URL: 'https://preview.example.test' }), 'realtime:preview.example.test');
  assert.equal(rule.realtimeChannel({ REALTIME_CHANNEL: 'staging', NEXTAUTH_URL: 'https://x.test' }), 'realtime:staging');
  assert.equal(rule.realtimeChannel({}), 'realtime:default');
  assert.deepEqual([1, 2, 3, 7, 20].map(rule.reconnectDelayMs), [1000, 2000, 4000, 60000, 60000]);
});

// ── The transport ────────────────────────────────────────────────────────────
test('two brokers on one channel: a publish in A reaches B (and A hears its own echo)', async () => {
  const srv = await startServer({ password: 's3cret' });
  cleanups.push(srv.close);
  const url = `redis://:s3cret@127.0.0.1:${srv.port}/2`;
  const gotA = [];
  const gotB = [];
  const a = startRealtimeBroker({ url, channel: 'realtime:t1', onMessage: (p) => gotA.push(p), logger: quiet });
  const b = startRealtimeBroker({ url, channel: 'realtime:t1', onMessage: (p) => gotB.push(p), logger: quiet });
  cleanups.push(() => (a.close(), b.close()));
  assert.ok(await waitFor(() => a.connected() && b.connected()), 'both connect and subscribe');
  await new Promise((r) => setTimeout(r, 50)); // let SUBSCRIBE land
  a.publish('{"hello":1}');
  assert.ok(await waitFor(() => gotB.length === 1), 'B received A’s publish');
  assert.deepEqual(gotB, ['{"hello":1}']);
  assert.ok(await waitFor(() => gotA.length === 1), 'A hears its own echo — the bus filters it by origin');
});

test('a wrong password never connects, and a dropped connection redials by itself', async () => {
  const srv = await startServer({ password: 'right' });
  cleanups.push(srv.close);
  const warnings = [];
  const bad = startRealtimeBroker({
    url: `redis://:wrong@127.0.0.1:${srv.port}`,
    channel: 'realtime:t2',
    onMessage: () => {},
    logger: { warning: (m) => warnings.push(m), info: () => {} },
  });
  cleanups.push(() => bad.close());
  assert.ok(await waitFor(() => warnings.length > 0));
  assert.equal(bad.connected(), false);
  assert.ok(!JSON.stringify(warnings).includes('wrong'), 'the password never reaches a log line');

  const infos = [];
  const ok = startRealtimeBroker({
    url: `redis://:right@127.0.0.1:${srv.port}`,
    channel: 'realtime:t2',
    onMessage: () => {},
    logger: { warning: () => {}, info: (m) => infos.push(m) },
  });
  cleanups.push(() => ok.close());
  assert.ok(await waitFor(() => ok.connected()));
  srv.dropAll();
  assert.ok(await waitFor(() => !ok.connected()), 'the drop is noticed');
  ok.publish('dropped while down'); // must not throw
  assert.ok(await waitFor(() => ok.connected(), 5000), 'redialled after the backoff');
  assert.ok(infos.some((m) => /reconnected/.test(m)));
});

// ── The bus, end to end ──────────────────────────────────────────────────────
test('the bus: a peer replica’s publish reaches a local listener; its own publishes go out once', async () => {
  const srv = await startServer();
  cleanups.push(srv.close);
  process.env.REALTIME_REDIS_URL = `redis://127.0.0.1:${srv.port}`;
  process.env.NEXTAUTH_URL = 'https://bus.example.test';
  const bus = await import('../../src/lib/realtimeBus.ts');

  const heard = [];
  const unsubscribe = bus.subscribeRealtime('user1', (e) => heard.push(e));
  cleanups.push(() => unsubscribe?.());

  // A second "replica": its own broker connection, a different origin.
  const peerSeen = [];
  const peer = startRealtimeBroker({
    url: process.env.REALTIME_REDIS_URL,
    channel: 'realtime:bus.example.test',
    onMessage: (p) => peerSeen.push(rule.decodeEnvelope(p)),
    logger: quiet,
  });
  cleanups.push(() => peer.close());
  assert.ok(await waitFor(() => peer.connected()));
  await new Promise((r) => setTimeout(r, 300)); // the bus's lazy broker connects and subscribes

  peer.publish(rule.encodeEnvelope('peerReplica', ['user1'], { type: 'message', conversationId: 'c9' }));
  assert.ok(await waitFor(() => heard.length === 1), 'the peer publish was delivered locally');
  assert.deepEqual(heard[0], { type: 'message', conversationId: 'c9' });

  bus.publishRealtime(['user1'], { type: 'read', conversationId: 'c9' });
  assert.equal(heard.length, 2, 'local delivery is synchronous, before the broker');
  assert.ok(await waitFor(() => peerSeen.some((e) => e?.e.type === 'read')), 'the peer heard it over the broker');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard.length, 2, 'its own echo is ignored — no double delivery');
  const own = peerSeen.find((e) => e?.e.type === 'read');
  assert.deepEqual(own.u, ['user1']);
  assert.notEqual(own.o, 'peerReplica');
});
