import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, cleanupByEmail, seedUser, uniqueEmail } from './helpers/db';

// Enforcement of the API-key lifecycle at the /api/v1 door (#1546).
//
// #1545 gave a key an expiry, a scope list, a soft revoke and an organisation;
// none of it changed anything, because `authenticateApiKey` returned `{ id }`
// for any key that existed and `/api/v1/candidates` then read every MENTEE in
// the database. These are the four refusals that close that hole, plus the
// scoping that makes an accepted key see one organisation and no other.
//
// API-only: no page, no browser, no sign-in — the keys are seeded straight into
// the database, which is also the only way to mint an already-expired one.

const KEY_PREFIX = 'e2e-v1-enforce';
const CANDIDATES = '/api/v1/candidates';

function bearer(raw: string) {
  return { authorization: `Bearer ${raw}` };
}

// Mint a key row with a known raw secret. The hash must match lib/apiKey.ts's
// (sha256 of the raw string) — hashing it here rather than importing keeps this
// spec free of the server-only module graph.
async function seedKey(opts: {
  scopes?: string;
  orgId?: string | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}) {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const key = await prisma.apiKey.create({
    data: {
      name: `${KEY_PREFIX}-${randomBytes(4).toString('hex')}`,
      hashedKey: createHash('sha256').update(raw).digest('hex'),
      scopes: opts.scopes ?? 'candidates:read',
      orgId: opts.orgId ?? null,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: opts.revokedAt ?? null,
    },
  });
  return { id: key.id, raw };
}

test.afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
  await prisma.$disconnect();
});

test('a key that is expired, revoked, out of scope or org-less never reaches candidate data', {
  tag: '@smoke',
}, async ({ request }) => {
  const org = await prisma.organization.create({
    data: { name: `V1 Enforce ${Date.now()}`, slug: `v1-enforce-${Date.now()}` },
  });
  const hour = 60 * 60 * 1000;
  try {
    // No credential at all is still a 401 — unchanged.
    expect((await request.get(CANDIDATES)).status()).toBe(401);
    expect((await request.get(CANDIDATES, { headers: bearer('icrm_nope') })).status()).toBe(401);

    // Expired: the expiry was recorded before, and ignored.
    const expired = await seedKey({ orgId: org.id, expiresAt: new Date(Date.now() - hour) });
    expect((await request.get(CANDIDATES, { headers: bearer(expired.raw) })).status()).toBe(401);

    // Revoked: the row survives the soft revoke, the credential must not.
    const revoked = await seedKey({ orgId: org.id, revokedAt: new Date(Date.now() - hour) });
    expect((await request.get(CANDIDATES, { headers: bearer(revoked.raw) })).status()).toBe(401);

    // Holding some other scope is holding nothing here — 403, not a filtered 200.
    const wrongScope = await seedKey({ orgId: org.id, scopes: 'candidates:write' });
    const scopeRes = await request.get(CANDIDATES, { headers: bearer(wrongScope.raw) });
    expect(scopeRes.status()).toBe(403);
    expect((await scopeRes.json()).candidates).toBeUndefined();

    // No resolvable organisation: refused, never served everything.
    const orgless = await seedKey({ orgId: null });
    const orglessRes = await request.get(CANDIDATES, { headers: bearer(orgless.raw) });
    expect(orglessRes.status()).toBe(403);
    expect((await orglessRes.json()).candidates).toBeUndefined();

    // The control: a live, in-scope, org-bound key is still served.
    const good = await seedKey({ orgId: org.id });
    const ok = await request.get(CANDIDATES, { headers: bearer(good.raw) });
    expect(ok.status()).toBe(200);
    expect(Array.isArray((await ok.json()).candidates)).toBeTruthy();
  } finally {
    await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('a key sees its own organisation and no other', async ({ request }) => {
  const stamp = Date.now();
  const orgA = await prisma.organization.create({
    data: { name: `V1 Org A ${stamp}`, slug: `v1-org-a-${stamp}` },
  });
  const orgB = await prisma.organization.create({
    data: { name: `V1 Org B ${stamp}`, slug: `v1-org-b-${stamp}` },
  });
  const emailA = uniqueEmail('v1-mentee-a');
  const emailB = uniqueEmail('v1-mentee-b');
  try {
    const menteeA = await seedUser(emailA, 'MenteePass123', 'MENTEE', `V1 Mentee A ${stamp}`);
    const menteeB = await seedUser(emailB, 'MenteePass123', 'MENTEE', `V1 Mentee B ${stamp}`);
    await prisma.user.update({ where: { id: menteeA.id }, data: { orgId: orgA.id } });
    await prisma.user.update({ where: { id: menteeB.id }, data: { orgId: orgB.id } });

    const keyA = await seedKey({ orgId: orgA.id });
    const res = await request.get(CANDIDATES, { headers: bearer(keyA.raw) });
    expect(res.status()).toBe(200);
    const ids = ((await res.json()).candidates as { id: string }[]).map((c) => c.id);

    expect(ids).toContain(menteeA.id);
    // The whole point: org B's mentee is not in org A's answer — and neither is
    // anybody else's, which is why the assertion is on the org, not on one row.
    expect(ids).not.toContain(menteeB.id);
    const foreign = await prisma.user.findMany({
      where: { id: { in: ids }, NOT: { orgId: orgA.id } },
      select: { id: true },
    });
    expect(foreign).toEqual([]);
  } finally {
    await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
    await cleanupByEmail(emailA);
    await cleanupByEmail(emailB);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
