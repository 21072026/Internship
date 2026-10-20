import { test, expect } from '@playwright/test';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiOk } from '@/lib/api/v1';
import { IDEMPOTENCY_TTL_MS, apiWrite, purgeExpiredIdempotencyKeys, writeOk } from '@/lib/api/v1Write';
import { dropApiOrg, seedApiOrg } from './helpers/apiKeys';

// The /api/v1 write floor (#1994, src/lib/api/v1Write.ts), driven through the
// real door (withApiKey) and the real database, with a stand-in handler that
// counts how often it actually ran — "creates nothing new" is that count.
// Browserless: the endpoints that use this floor (#1996) carry their own specs.

const URL_ = 'http://localhost/api/v1/_write-foundation';
const schema = z.object({ name: z.string().min(1).max(50), count: z.number().int().optional() });

function post(headers: Record<string, string>, body: unknown, idemKey?: string) {
  return new Request(URL_, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('write scope, idempotent replay, the 409 on a changed body, the 422 contract and the activity row', {
  tag: '@smoke',
}, async () => {
  const writer = await seedApiOrg('V1 Write Floor', 'interactions:write');
  const reader = await seedApiOrg('V1 Write Floor Reader', 'candidates:read');
  let runs = 0;
  const call = (req: Request) =>
    withApiKey(req, 'interactions:write', (key) =>
      apiWrite(req, key, schema, async (body) => {
        runs++;
        return writeOk(apiOk({ name: body.name, run: runs }, undefined, undefined, { status: 201 }), {
          action: 'api.test_write',
          targetType: 'Test',
          targetId: `run-${runs}`,
        });
      }),
    );
  try {
    // A key without the write scope never reaches the handler.
    const refused = await call(post(reader.headers, { name: 'x' }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ type: 'insufficient_scope' });
    expect(runs).toBe(0);

    // The first request runs; the retry with the same key and body replays it.
    const idem = `idem-${Date.now()}`;
    const first = await call(post(writer.headers, { name: 'Ada' }, idem));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const replay = await call(post(writer.headers, { name: 'Ada' }, idem));
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await replay.json()).toEqual(firstBody);
    expect(runs).toBe(1);

    // Same key, different body: refused, nothing written.
    const reused = await call(post(writer.headers, { name: 'Grace' }, idem));
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ type: 'idempotency_key_reused' });
    expect(runs).toBe(1);

    // An invalid body is a 422 naming each field — and frees no key it never claimed.
    const invalid = await call(post(writer.headers, { name: '', count: 1.5 }, `bad-${Date.now()}`));
    expect(invalid.status).toBe(422);
    const problem = await invalid.json();
    expect(problem.type).toBe('validation_failed');
    expect(problem.errors.map((e: { path: string }) => e.path).sort()).toEqual(['count', 'name']);
    expect(problem.errors[0]).toEqual(expect.objectContaining({ code: expect.any(String), message: expect.any(String) }));
    const notJson = await call(post(writer.headers, '{nope'));
    expect(notJson.status).toBe(422);
    expect(runs).toBe(1);

    // Every accepted write leaves an activity row naming the key.
    const keyRow = await prisma.apiKey.findFirstOrThrow({ where: { orgId: writer.orgId }, select: { id: true } });
    const activity = await prisma.activityLog.findMany({ where: { action: 'api.test_write', orgId: writer.orgId } });
    expect(activity).toHaveLength(1);
    expect(activity[0].detail).toContain(`api key ${keyRow.id}`);
    expect(activity[0].targetId).toBe('run-1');

    // Past the window the row is swept, and the key is usable again.
    await prisma.apiIdempotencyKey.updateMany({
      where: { apiKeyId: keyRow.id },
      data: { createdAt: new Date(Date.now() - IDEMPOTENCY_TTL_MS - 60_000) },
    });
    expect(await purgeExpiredIdempotencyKeys()).toBeGreaterThanOrEqual(1);
    expect(await prisma.apiIdempotencyKey.count({ where: { apiKeyId: keyRow.id } })).toBe(0);
    expect((await call(post(writer.headers, { name: 'Grace' }, idem))).status).toBe(201);
    expect(runs).toBe(2);
  } finally {
    await prisma.activityLog.deleteMany({ where: { orgId: { in: [writer.orgId, reader.orgId] } } });
    await dropApiOrg(writer.orgId);
    await dropApiOrg(reader.orgId);
  }
});
