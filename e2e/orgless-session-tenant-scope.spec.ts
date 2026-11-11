import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// A session without an org — a token minted before the org backfill — belongs
// to the DEFAULT org, never to "every org" (#3603, src/lib/tenantFilter.ts).
// The tag routes used `orgId ?? undefined`, which drops the filter for such a
// session. Here an org-less admin must get a 404 for another org's tag, on
// rename, delete and merge, and the tag must be untouched — flag off, as in
// every deployment.

const PASSWORD = 'OrglessScope123!';

test.afterAll(async () => prisma.$disconnect());

test('an org-less admin session is the default org\'s, never every org\'s', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgB = await prisma.organization.create({ data: { name: `OL B ${s}`, slug: `ol-b-${s}`, plan: 'ENTERPRISE' } });
  const adminEmail = uniqueEmail('ol-admin').toLowerCase();
  try {
    const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'OL Orgless Admin', null);
    await prisma.user.update({ where: { id: admin.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const foreign = await prisma.tag.create({ data: { orgId: orgB.id, name: `ol-foreign-${s}` } });
    const foreignInto = await prisma.tag.create({ data: { orgId: orgB.id, name: `ol-into-${s}` } });

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, adminEmail, PASSWORD);
    expect(signed.ok, `sign-in failed: ${signed.error}`).toBe(true);

    expect((await ctx.patch(`/api/tags/${foreign.id}`, { data: { name: `renamed-${s}` } })).status()).toBe(404);
    expect((await ctx.post(`/api/tags/${foreign.id}/merge`, { data: { into: foreignInto.id } })).status()).toBe(404);
    expect((await ctx.delete(`/api/tags/${foreign.id}`)).status()).toBe(404);
    const after = await prisma.tag.findUnique({ where: { id: foreign.id } });
    expect(after?.name).toBe(`ol-foreign-${s}`);
    await ctx.dispose();
  } finally {
    await prisma.userTag.deleteMany({ where: { tag: { orgId: orgB.id } } });
    await prisma.tag.deleteMany({ where: { orgId: orgB.id } });
    await cleanupByEmail(adminEmail);
    await prisma.organization.deleteMany({ where: { id: orgB.id } });
  }
});
