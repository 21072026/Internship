// Unit tests for the error tracker (#1600) — pure node, no browser, no database.
// Run with BASE_URL=http://localhost:9 to skip the webServer.
//
// What they prove: an event built from a representative failure carries no
// e-mail address, no ORM argument dump, no token, no query value and no tag
// outside the allowlist; with no DSN nothing is sent; with a DSN one envelope
// in the Sentry protocol goes to the right URL; and the job worker reports a
// retry and a dead-letter through its onError hook.
import { test, expect } from '@playwright/test';
import {
  EventThrottle,
  buildEvent,
  envelopeBody,
  parseDsn,
  parseStack,
  scrubMessage,
  scrubTags,
} from '../src/lib/errorTrackingRule';
import { captureError, errorTrackingEnabled } from '../src/lib/errorTracking';
import { createMemoryQueueStore, enqueue, setQueueLogger } from '../src/lib/jobs/queue';
import { createJobRegistry } from '../src/lib/jobs/registry';
import { createWorker } from '../src/lib/jobs/worker';

setQueueLogger({ warning: () => {} });

const RELEASE = { release: 'abc1234', version: '1.2.3', environment: 'preview' };
const NOW = new Date('2026-10-27T10:00:00Z');

function prismaLikeError(): Error {
  const e = new Error(
    'Invalid `prisma.user.create()` invocation:\n\n{\n  data: {\n    email: "ada.lovelace@example.test",\n    name: "Ada Lovelace",\n    bio: "CV text here"\n  }\n}\nUnique constraint failed',
  );
  e.name = 'PrismaClientKnownRequestError';
  e.stack = [
    `${e.name}: Invalid prisma.user.create() invocation for ada.lovelace@example.test`,
    '    at createUser (/app/.next/server/app/api/register/route.js:12:34)',
    '    at async POST (/app/.next/server/app/api/register/route.js:40:5)',
    '    at /app/node_modules/next/dist/server/base-server.js:100:7',
  ].join('\n');
  return e;
}

test.describe('error tracker', { tag: '@smoke' }, () => {
  test('a representative event carries no address, no name, no argument dump, no token', () => {
    const event = buildEvent(
      {
        error: prismaLikeError(),
        tags: {
          source: 'server',
          route: '/admin/users?email=ada.lovelace%40example.test&token=s3cret',
          role: 'ADMIN',
          orgId: 'org_1',
          requestId: 'req-1',
          // Not in the allowlist: must be dropped whole.
          ...({ email: 'ada.lovelace@example.test', fullName: 'Ada Lovelace', body: 'hello' } as object),
        },
      },
      RELEASE,
      'e'.repeat(32),
      NOW,
    );
    const json = JSON.stringify(event);
    expect(json).not.toContain('ada.lovelace');
    expect(json).not.toContain('example.test');
    expect(json).not.toContain('Ada Lovelace');
    expect(json).not.toContain('CV text');
    expect(json).not.toContain('s3cret');
    expect(json).not.toContain('hello');
    expect(event.exception.values[0].value).toBe('Invalid `prisma.user.create()` invocation:');
    expect(event.tags).toEqual({
      source: 'server',
      route: '/admin/users',
      role: 'ADMIN',
      orgId: 'org_1',
      requestId: 'req-1',
      version: '1.2.3',
    });
    expect(event).toMatchObject({ release: 'abc1234', environment: 'preview', level: 'error', transaction: '/admin/users' });
  });

  test('stack frames are caller-first, masked, and library frames are not in_app', () => {
    const frames = parseStack(prismaLikeError().stack);
    expect(frames.map((f) => f.function)).toEqual(['?', 'async POST', 'createUser']);
    expect(frames[0].in_app).toBe(false);
    expect(frames[2]).toMatchObject({ filename: '/app/.next/server/app/api/register/route.js', lineno: 12, colno: 34, in_app: true });
    expect(parseStack('fn@https://app.example.test/_next/static/chunks/page.js?token=x:1:2')[0].filename)
      .toBe('https://app.example.test/_next/static/chunks/page.js?token=***');
  });

  test('message: first line only, bearer tokens and JWTs masked, bounded', () => {
    expect(scrubMessage('fetch failed: Bearer abc.def.ghi\nsecond line')).toBe('fetch failed: Bearer ***');
    expect(scrubMessage('x'.repeat(1000))).toHaveLength(300);
    expect(scrubMessage(undefined)).toBe('');
  });

  test('tags: an unsafe value is dropped, not truncated into something misleading', () => {
    expect(scrubTags({ role: 'ADMIN"; drop', orgId: '', job: 'mail.digest' })).toEqual({ job: 'mail.digest' });
  });

  test('DSN: only https (or local http) with a key and a project id', () => {
    expect(parseDsn('https://pub123@errors.example.test/42')).toEqual({
      envelopeUrl: 'https://errors.example.test/api/42/envelope/',
      publicKey: 'pub123',
    });
    expect(parseDsn('https://k@errors.example.test/prefix/7')?.envelopeUrl).toBe('https://errors.example.test/prefix/api/7/envelope/');
    expect(parseDsn('http://k@localhost:8000/1')?.envelopeUrl).toBe('http://localhost:8000/api/1/envelope/');
    for (const bad of ['', undefined, 'not a url', 'http://k@errors.example.test/1', 'https://errors.example.test/1', 'https://k@errors.example.test/']) {
      expect(parseDsn(bad)).toBeNull();
    }
  });

  test('envelope: header, item header and event as three NDJSON lines', () => {
    const event = buildEvent({ error: new Error('boom') }, RELEASE, 'a'.repeat(32), NOW);
    const lines = envelopeBody(event, NOW).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ event_id: 'a'.repeat(32), sent_at: NOW.toISOString() });
    expect(JSON.parse(lines[1])).toEqual({ type: 'event' });
    expect(JSON.parse(lines[2]).exception.values[0].value).toBe('boom');
  });

  test('throttle: at most N events per key per window', () => {
    const t = new EventThrottle(2, 1000);
    expect([t.allow('k', 0), t.allow('k', 1), t.allow('k', 2), t.allow('other', 2), t.allow('k', 1000)]).toEqual([true, true, false, true, true]);
  });

  test('no DSN → no fetch, no console line', async () => {
    const saved = process.env.ERROR_TRACKING_DSN;
    delete process.env.ERROR_TRACKING_DSN;
    const realFetch = globalThis.fetch;
    const realWarn = console.warn;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(null);
    }) as typeof fetch;
    console.warn = () => {
      calls++;
    };
    try {
      expect(errorTrackingEnabled()).toBe(false);
      expect(await captureError({ error: new Error('x') })).toBeNull();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      console.warn = realWarn;
      if (saved !== undefined) process.env.ERROR_TRACKING_DSN = saved;
    }
  });

  test('with a DSN → one envelope to the right URL, auth header, no address in the body', async () => {
    const saved = process.env.ERROR_TRACKING_DSN;
    process.env.ERROR_TRACKING_DSN = 'https://pubkey@errors.example.test/9';
    const realFetch = globalThis.fetch;
    const seen: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      const id = await captureError({ error: prismaLikeError(), tags: { source: 'server', route: '/api/register' } });
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe('https://errors.example.test/api/9/envelope/');
      expect((seen[0].init.headers as Record<string, string>)['X-Sentry-Auth']).toContain('sentry_key=pubkey');
      expect(String(seen[0].init.body)).not.toContain('example.test');
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.ERROR_TRACKING_DSN;
      else process.env.ERROR_TRACKING_DSN = saved;
    }
  });

  test('job worker: every failed attempt reaches onError, the last one as deadLettered', async () => {
    const store = createMemoryQueueStore();
    const registry = createJobRegistry();
    const seen: { name: string; attempts: number; outcome: string; message: string }[] = [];
    let now = NOW;
    const worker = createWorker({
      store,
      registry,
      workerId: 'w#1',
      now: () => now,
      random: () => 0.5,
      logger: { info: () => {}, warning: () => {}, error: () => {} },
      onError: (job, error, outcome) => {
        seen.push({ name: job.name, attempts: job.attempts, outcome, message: (error as Error).message });
        throw new Error('a broken reporter must not change the settle');
      },
    });
    registry.register('test.fail' as never, async () => {
      throw new Error('boom');
    });
    await enqueue('test.fail' as never, {} as never, { store, now: () => now, maxAttempts: 2 });
    await worker.tick();
    now = store.jobs[0].runAt;
    await worker.tick();
    expect(seen).toEqual([
      { name: 'test.fail', attempts: 1, outcome: 'retried', message: 'boom' },
      { name: 'test.fail', attempts: 2, outcome: 'deadLettered', message: 'boom' },
    ]);
    expect(store.jobs[0].status).toBe('DEAD_LETTER');
  });
});
