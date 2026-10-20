import { test, expect } from '@playwright/test';
import { prisma } from './helpers/db';
import { dropApiOrg, seedApiOrg } from './helpers/apiKeys';

// The /api/v1 contract (#1988, src/lib/api/v1.ts): the `{ data, page }`
// envelope, a keyset cursor over (updatedAt, id), `?updatedSince=` and one
// RFC 9457 error shape with a stable `type`.
//
// API-only: the mentees are written straight into a throwaway org with fixed
// `updatedAt` values, so every page boundary is known in advance.

const CANDIDATES = '/api/v1/candidates';

async function seedMentees(orgId: string, count: number, base: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const u = await prisma.user.create({
      data: {
        email: `v1-contract-${base}-${i}@e2e.local`,
        fullName: `V1 Contract ${i}`,
        password: 'not-a-login',
        role: 'MENTEE',
        orgId,
        // One second apart, oldest first: the expected walk order.
        updatedAt: new Date(base + i * 1000),
      },
    });
    ids.push(u.id);
  }
  return ids;
}

test('a malformed or tampered cursor is a 400 validation_failed, and every refusal carries a stable type', {
  tag: '@smoke',
}, async ({ request }) => {
  const { orgId, headers } = await seedApiOrg('V1 Contract Errors');
  try {
    // The door's refusals: a problem document with a slug, not a bare string.
    const anon = await request.get(CANDIDATES);
    expect(anon.status()).toBe(401);
    expect(anon.headers()['content-type']).toContain('application/problem+json');
    expect(await anon.json()).toMatchObject({ type: 'invalid_api_key', status: 401 });

    const ok = await request.get(`${CANDIDATES}?limit=1`, { headers });
    expect(ok.status()).toBe(200);

    // A cursor someone edited, a cursor that is not one at all, and a real
    // cursor re-signed for a different resource are all refused — never served
    // as page one.
    const seeded = await seedMentees(orgId, 2, Date.UTC(2026, 0, 1));
    const first = await (await request.get(`${CANDIDATES}?limit=1`, { headers })).json();
    expect(first.data.map((c: { id: string }) => c.id)).toEqual([seeded[0]]);
    const cursor: string = first.page.nextCursor;
    expect(cursor).toBeTruthy();
    const [payload, sig] = cursor.split('.');
    const forged = Buffer.from(JSON.stringify([0, ''])).toString('base64url');
    for (const bad of [`${forged}.${sig}`, 'not-a-cursor', `${payload}.${sig.slice(1)}x`, `${payload}`]) {
      const res = await request.get(`${CANDIDATES}?cursor=${encodeURIComponent(bad)}`, { headers });
      expect(res.status(), bad).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ type: 'validation_failed', status: 400 });
      expect(body.fields).toEqual([expect.objectContaining({ field: 'cursor' })]);
      expect(body.data).toBeUndefined();
    }

    // A non-ISO updatedSince is refused too, rather than read as some instant.
    const since = await request.get(`${CANDIDATES}?updatedSince=yesterday`, { headers });
    expect(since.status()).toBe(400);
    expect((await since.json()).fields).toEqual([expect.objectContaining({ field: 'updatedSince' })]);
  } finally {
    await prisma.user.deleteMany({ where: { orgId } });
    await dropApiOrg(orgId);
  }
});

test('the cursor walks the whole set without gaps or duplicates, meets a row edited mid-walk, and updatedSince returns the delta', async ({ request }) => {
  const { orgId, headers } = await seedApiOrg('V1 Contract Walk');
  try {
    const base = Date.UTC(2026, 0, 1);
    const ids = await seedMentees(orgId, 5, base);

    // Page one: two rows, a cursor, and the deprecated alias mirroring `data`.
    const res = await request.get(`${CANDIDATES}?limit=2`, { headers });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.map((c: { id: string }) => c.id)).toEqual(ids.slice(0, 2));
    expect(body.page.hasMore).toBe(true);
    expect(body.candidates).toEqual(body.data);
    expect(body.data[0].updatedAt).toBe(new Date(base).toISOString());

    // Row 3 changes after page one was read: it moves to the end of the walk
    // instead of being skipped.
    await prisma.user.update({ where: { id: ids[2] }, data: { updatedAt: new Date(base + 60_000) } });

    const seen: string[] = body.data.map((c: { id: string }) => c.id);
    let cursor: string | null = body.page.nextCursor;
    while (cursor) {
      const next = await (await request.get(`${CANDIDATES}?limit=2&cursor=${encodeURIComponent(cursor)}`, { headers })).json();
      seen.push(...next.data.map((c: { id: string }) => c.id));
      cursor = next.page.nextCursor;
      expect(next.page.hasMore).toBe(cursor !== null);
    }
    expect(seen).toEqual([ids[0], ids[1], ids[3], ids[4], ids[2]]);

    // Over the maximum is clamped, not an error.
    const big = await request.get(`${CANDIDATES}?limit=100000`, { headers });
    expect(big.status()).toBe(200);
    expect((await big.json()).data).toHaveLength(5);

    // The delta: rows changed at or after the instant, inclusive.
    const sinceIso = new Date(base + 3000).toISOString();
    const delta = await (await request.get(`${CANDIDATES}?updatedSince=${encodeURIComponent(sinceIso)}`, { headers })).json();
    expect(delta.data.map((c: { id: string }) => c.id)).toEqual([ids[3], ids[4], ids[2]]);
    expect(delta.page).toEqual({ nextCursor: null, hasMore: false });
  } finally {
    await prisma.user.deleteMany({ where: { orgId } });
    await dropApiOrg(orgId);
  }
});
