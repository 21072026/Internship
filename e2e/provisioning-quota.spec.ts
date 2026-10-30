import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { planLimits } from '../src/lib/plans';

// Provisioning quotas (#1752), on a Community (free) tenant — 2 admin seats,
// 3 companies, 1 programme:
//   1. FREE CORE (@smoke): at a full admin band, inviting a MENTOR or a MENTEE
//      still succeeds — they are never counted — while one more ADMIN is a
//      403 plan_limit_reached from the ROUTE;
//   2. creating a company or a programme past the band is refused, existing
//      rows untouched, and accepting an ADMIN invitation into a full org is
//      refused with no plan name in the body.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const PW = 'QuotaPass123!x';
const band = planLimits('community');

async function freeOrg(label: string) {
  const stamp = `${Date.now()}${Math.round(performance.now())}`;
  const org = await prisma.organization.create({ data: { name: `Quota ${label} ${stamp}`, slug: `quota-${label}-${stamp}`.slice(0, 60), plan: 'FREE' } });
  await prisma.subscription.create({ data: { orgId: org.id, planKey: 'community', status: 'ACTIVE', interval: 'MONTHLY' } });
  return { org, stamp };
}

async function cleanup(orgId: string, emails: string[]) {
  await prisma.invitationToken.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.cohort.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.subscription.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
}

const invite = (request: APIRequestContext, role: string, email: string) =>
  request.post('/api/invite', { data: { email, role } });

test('a full admin band refuses one more ADMIN, never a MENTOR or a MENTEE', { tag: '@smoke' }, async ({ page }) => {
  const { org, stamp } = await freeOrg('seats');
  const admins = Array.from({ length: band.adminSeats! }, (_, i) => uniqueEmail(`quota-admin${i}`));
  const invitees = ['mentor', 'mentee', 'admin'].map((k) => `quota-${k}.${stamp}@example.test`);
  try {
    for (const [i, e] of admins.entries()) await seedUser(e, PW, 'ADMIN', `Quota Admin ${i}`, org.id);
    await signInAndSettle(page, admins[0], PW, '/admin');

    // The free core: invited at a full band, and nothing is counted.
    expect((await invite(page.request, 'MENTOR', invitees[0])).status()).toBe(201);
    expect((await invite(page.request, 'MENTEE', invitees[1])).status()).toBe(201);

    const res = await invite(page.request, 'ADMIN', invitees[2]);
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('plan_limit_reached');
    expect(body.metric).toBe('ADMIN_SEATS');
    expect(body.limit).toBe(band.adminSeats);
    expect(body.usage).toBe(band.adminSeats);
    expect(await prisma.invitationToken.count({ where: { orgId: org.id, role: 'ADMIN' } })).toBe(0);
  } finally {
    await cleanup(org.id, [...admins, ...invitees]);
  }
});

test('companies and programmes stop at the band; a full org refuses an ADMIN acceptance', async ({ page, request }) => {
  const { org, stamp } = await freeOrg('objects');
  const adminEmail = uniqueEmail('quota-objadmin');
  const invitee = `quota-accept.${stamp}@example.test`;
  try {
    const admin = await seedUser(adminEmail, PW, 'ADMIN', 'Quota Object Admin', org.id);
    for (let i = 0; i < band.companies!; i++) await prisma.company.create({ data: { orgId: org.id, name: `Quota Co ${i} ${stamp}` } });
    for (let i = 0; i < band.programs!; i++) await prisma.cohort.create({ data: { orgId: org.id, name: `Quota Cohort ${i} ${stamp}` } });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    const co = await page.request.post('/api/companies', { data: { name: `Quota Overflow ${stamp}` } });
    expect(co.status()).toBe(403);
    expect((await co.json()).metric).toBe('COMPANIES');
    const cohort = await page.request.post('/api/cohorts', { data: { name: `Quota Cohort Overflow ${stamp}` } });
    expect(cohort.status()).toBe(403);
    expect((await cohort.json()).metric).toBe('PROGRAMS');
    expect(await prisma.company.count({ where: { orgId: org.id } })).toBe(band.companies);
    expect(await prisma.cohort.count({ where: { orgId: org.id } })).toBe(band.programs);

    // An ADMIN invitation minted before the band filled (seeded directly), then
    // a second admin fills it: the acceptance is refused, and the invitee — not
    // the buyer — reads no plan name.
    const token = `quota-${stamp}`;
    await prisma.invitationToken.create({
      data: { token, email: invitee, role: 'ADMIN', orgId: org.id, invitedById: admin.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await seedUser(uniqueEmail('quota-second'), PW, 'ADMIN', 'Quota Second Admin', org.id);
    const reg = await request.post('/api/register', { data: { token, email: invitee, password: PW, fullName: 'Quota Invitee', consent: true } });
    expect(reg.status()).toBe(403);
    expect((await reg.json()).code).toBe('plan_limit_reached');
    expect(await prisma.user.count({ where: { email: invitee } })).toBe(0);
  } finally {
    await prisma.user.deleteMany({ where: { orgId: org.id, fullName: 'Quota Second Admin' } }).catch(() => {});
    await cleanup(org.id, [adminEmail, invitee]);
  }
});
