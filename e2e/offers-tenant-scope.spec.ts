import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Offers stay inside the caller's org (#3588). The tenant middleware is off in
// every deployment (and in this project), so each offers route writes the org
// into its own queries. An admin of org A must not read, list, change, create
// on, or benchmark org B's offers — another org's id reads as missing (404).

const PASSWORD = 'OfferScope123!';

test.afterAll(async () => prisma.$disconnect());

test('offers: another org\'s offer, relation and company read as missing to an admin', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `OS A ${s}`, slug: `os-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `OS B ${s}`, slug: `os-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['os-a-admin', 'os-a-mentor', 'os-a-mentee', 'os-b-admin', 'os-b-mentor', 'os-b-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdmin, aMentor, aMentee, bAdmin, bMentor, bMentee] = emails;
  const bPosition = `Foreign Position ${s}`;
  try {
    const adminA = await seedUser(aAdmin, PASSWORD, 'ADMIN', 'OS A Admin', orgA.id);
    await prisma.user.update({ where: { id: adminA.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const am = await seedUser(aMentor, PASSWORD, 'MENTOR', 'OS A Mentor', orgA.id);
    const ae = await seedUser(aMentee, PASSWORD, 'MENTEE', 'OS A Mentee', orgA.id);
    const adminB = await seedUser(bAdmin, PASSWORD, 'ADMIN', 'OS B Admin', orgB.id);
    const bm = await seedUser(bMentor, PASSWORD, 'MENTOR', 'OS B Mentor', orgB.id);
    const be = await seedUser(bMentee, PASSWORD, 'MENTEE', 'OS B Mentee', orgB.id);
    const aRel = await prisma.mentorshipRelation.create({ data: { orgId: orgA.id, mentorId: am.id, menteeId: ae.id } });
    const bRel = await prisma.mentorshipRelation.create({ data: { orgId: orgB.id, mentorId: bm.id, menteeId: be.id } });
    const bCompany = await prisma.company.create({ data: { orgId: orgB.id, name: `OS B Company ${s}` } });
    const aOffer = await prisma.offer.create({ data: { orgId: orgA.id, relationId: aRel.id, position: `Own Position ${s}`, createdById: adminA.id } });
    const bOffer = await prisma.offer.create({
      data: {
        orgId: orgB.id,
        relationId: bRel.id,
        position: bPosition,
        createdById: adminB.id,
        status: 'ACCEPTED',
        currency: 'EUR',
        baseAmountMinor: 420000,
        basePeriod: 'MONTHLY',
        decidedAt: new Date(),
      },
    });

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, aAdmin, PASSWORD);
    expect(signed.ok, signed.error).toBe(true);

    // Negative control: the admin's own offer opens.
    expect((await ctx.get(`/api/offers/${aOffer.id}`)).status()).toBe(200);

    // Another org's offer: missing for read and write, and unchanged.
    expect((await ctx.get(`/api/offers/${bOffer.id}`)).status()).toBe(404);
    expect((await ctx.patch(`/api/offers/${bOffer.id}`, { data: { position: 'Renamed across tenants' } })).status()).toBe(404);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: bOffer.id } })).position).toBe(bPosition);

    // The admin list carries the own offer and never the foreign one.
    const list = await ctx.get('/api/offers?pageSize=100');
    expect(list.status()).toBe(200);
    const listText = await list.text();
    expect(listText).toContain(aOffer.id);
    expect(listText).not.toContain(bOffer.id);

    // Creating on another org's relation, or naming another org's company: missing.
    expect((await ctx.post('/api/offers', { data: { relationId: bRel.id, position: 'Across tenants' } })).status()).toBe(404);
    expect((await ctx.post('/api/offers', { data: { relationId: aRel.id, companyId: bCompany.id, position: 'Across tenants' } })).status()).toBe(404);
    expect((await ctx.patch(`/api/offers/${aOffer.id}`, { data: { companyId: bCompany.id } })).status()).toBe(404);
    expect(await prisma.offer.count({ where: { position: 'Across tenants' } })).toBe(0);

    // The pay benchmark is computed over the caller's org only.
    const bench = await ctx.get('/api/admin/offers/benchmark');
    expect(bench.status()).toBe(200);
    expect((await bench.text()).toLowerCase()).not.toContain(bPosition.toLowerCase());
    await ctx.dispose();
  } finally {
    await prisma.offer.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.company.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
