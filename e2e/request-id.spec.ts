import { test, expect } from '@playwright/test';
import { logger } from '@/lib/logger';
import { currentRequestId, withRequestContext, withRequestScope } from '@/lib/requestContext';
import { REQUEST_ID_HEADER, isValidRequestId, MAX_REQUEST_ID_LENGTH } from '@/lib/requestId';

// The request id, end to end (#1601).
//
// Two halves, in one file because they are one feature:
//   - over HTTP: middleware puts `x-request-id` on the response of every matched
//     request, honours a well-formed inbound one, and refuses a hostile one.
//     The error responses matter most — those are the requests somebody files a
//     ticket about.
//   - in process: the AsyncLocalStorage that carries the id into every
//     `logger.*` line without a caller passing it. Node's own test runner
//     cannot import a module with extensionless relative imports (that is why
//     the pure grammar lives in scripts/test/request-id.test.mjs), so the
//     context half is tested here, through Playwright's transpiler.

const UUID_ISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test.describe('x-request-id over HTTP', () => {
  test('a page response carries a well-formed id', async ({ request }) => {
    const res = await request.get('/');
    const id = res.headers()[REQUEST_ID_HEADER];
    expect(id, 'every matched response carries the header').toBeTruthy();
    expect(isValidRequestId(id)).toBe(true);
  });

  test('two requests get two different ids', async ({ request }) => {
    const [a, b] = await Promise.all([request.get('/'), request.get('/')]);
    expect(a.headers()[REQUEST_ID_HEADER]).not.toBe(b.headers()[REQUEST_ID_HEADER]);
  });

  test('an inbound id is honoured rather than replaced', async ({ request }) => {
    const mine = 'e2e-inbound-4bf92f3577b34da6';
    const res = await request.get('/api/health', { headers: { [REQUEST_ID_HEADER]: mine } });
    expect(res.headers()[REQUEST_ID_HEADER]).toBe(mine);
  });

  test('a hostile inbound id is replaced, never echoed', async ({ request }) => {
    const hostile = 'x'.repeat(MAX_REQUEST_ID_LENGTH + 1);
    const res = await request.get('/api/health', { headers: { [REQUEST_ID_HEADER]: hostile } });
    const id = res.headers()[REQUEST_ID_HEADER];
    expect(id).not.toBe(hostile);
    expect(id).toMatch(UUID_ISH);
  });

  test('an error response carries the id too — those are the ones people ask about', async ({
    request,
  }) => {
    // Unauthenticated write: refused by the route, and the refusal is exactly
    // the response a support ticket will be about.
    const res = await request.post('/api/messages', { data: { body: 'nope' } });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const id = res.headers()[REQUEST_ID_HEADER];
    expect(isValidRequestId(id)).toBe(true);
  });

  test('an id supplied by the caller survives every hop of a redirect chain', async ({
    request,
  }) => {
    const mine = 'e2e-chain-0e0e4736';
    // /portal is role-gated: signed out it answers with a redirect. Whatever the
    // status, the response must carry the id the caller named.
    const res = await request.get('/portal', {
      headers: { [REQUEST_ID_HEADER]: mine },
      maxRedirects: 0,
    });
    expect(res.headers()[REQUEST_ID_HEADER]).toBe(mine);
  });
});

test.describe('the request context', () => {
  test('the id is readable anywhere inside the scope and nowhere outside it', () => {
    expect(currentRequestId()).toBeUndefined();
    const seen = withRequestContext('ctx-abc-123', () => currentRequestId());
    expect(seen).toBe('ctx-abc-123');
    expect(currentRequestId()).toBeUndefined();
  });

  test('withRequestScope reads the header middleware forwarded', () => {
    const req = new Request('http://localhost/api/x', {
      headers: { [REQUEST_ID_HEADER]: 'forwarded-77' },
    });
    expect(withRequestScope(req, () => currentRequestId())).toBe('forwarded-77');
  });

  test('a handler reached without middleware still gets an id', () => {
    const id = withRequestScope(new Request('http://localhost/api/x'), () => currentRequestId());
    expect(id).toMatch(UUID_ISH);
  });

  test('a hostile forwarded header cannot enter the context', () => {
    const req = new Request('http://localhost/api/x', {
      // Header values cannot carry a raw newline, so the injection attempt that
      // actually reaches us is one with the characters a JSON payload minds.
      headers: { [REQUEST_ID_HEADER]: '","level":"error","message":"forged' },
    });
    expect(withRequestScope(req, () => currentRequestId())).toMatch(UUID_ISH);
  });

  test('nesting keeps the outer id — one request, one id', () => {
    const inner = withRequestContext('outer-1', () => withRequestContext('inner-2', () => currentRequestId()));
    expect(inner).toBe('outer-1');
  });

  test('the id survives awaits and stays separate between concurrent requests', async () => {
    const handle = async (id: string) =>
      withRequestScope(new Request('http://localhost/', { headers: { [REQUEST_ID_HEADER]: id } }), async () => {
        await new Promise((r) => setTimeout(r, 10));
        const afterAwait = currentRequestId();
        await new Promise((r) => setTimeout(r, 10));
        return [afterAwait, currentRequestId()];
      });
    const [first, second] = await Promise.all([handle('req-aaa'), handle('req-bbb')]);
    expect(first).toEqual(['req-aaa', 'req-aaa']);
    expect(second).toEqual(['req-bbb', 'req-bbb']);
  });
});

test.describe('the logger stamps the id by itself', () => {
  // The point of the whole feature: a caller that knows nothing about request
  // ids still produces a log line that can be traced to one request.
  const captureLines = (fn: () => void): Record<string, unknown>[] => {
    const lines: Record<string, unknown>[] = [];
    const original = console.log;
    console.log = (_prefix: unknown, payload?: unknown) => {
      if (typeof payload === 'string') lines.push(JSON.parse(payload));
    };
    try {
      fn();
    } finally {
      console.log = original;
    }
    return lines;
  };

  test('a line emitted inside the scope carries requestId; one outside does not', () => {
    const inside = captureLines(() =>
      withRequestContext('log-req-1', () => logger.info('Webhook lookup failed', { webhookId: 'w1' }))
    );
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({
      level: 'info',
      message: 'Webhook lookup failed',
      requestId: 'log-req-1',
      webhookId: 'w1',
    });

    const outside = captureLines(() => logger.info('Cron tick'));
    expect(outside).toHaveLength(1);
    expect(outside[0]).not.toHaveProperty('requestId');
  });

  test('an explicit context still wins over the ambient one', () => {
    const lines = captureLines(() =>
      withRequestContext('ambient-1', () => logger.info('Replaying', { requestId: 'other-req' }))
    );
    expect(lines[0].requestId).toBe('other-req');
  });
});
