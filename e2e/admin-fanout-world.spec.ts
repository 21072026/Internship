import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { freshIp } from './helpers/rateLimit';

// Admin fan-outs stay in the org the event belongs to (docs/worlds.md).
//
// The public intake routes bind no tenant context, and withTenantScope() does
// not scope `User` while isolation is off — so `{ role: 'ADMIN' }` used to be
// every admin of every tenant in both products: an internship self-registration
// or mentor application rang the bell of every SaleVali admin, with the
// person's name. #2569 fixed the company-inquiry form; these pin the rest.

const MARKETING_HOST = 'marketing.bcsit-gmbh.de';
const PW = 'AdminFanout123!';
const emails: string[] = [];
let marketingOrgId = '';
let internshipAdminId = '';
let marketingAdminId = '';

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const org = await prisma.organization.create({
    data: { name: `Fanout Marketing ${stamp}`, slug: `fanout-mkt-${stamp}`, vertical: 'MARKETING' },
    select: { id: true },
  });
  marketingOrgId = org.id;
  const defaultOrg = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  const internshipAdminEmail = uniqueEmail('fanout-int-admin');
  const marketingAdminEmail = uniqueEmail('fanout-mkt-admin');
  emails.push(internshipAdminEmail, marketingAdminEmail);
  internshipAdminId = (await seedUser(internshipAdminEmail, PW, 'ADMIN', 'Fanout Int Admin', defaultOrg.id)).id;
  marketingAdminId = (await seedUser(marketingAdminEmail, PW, 'ADMIN', 'Fanout Mkt Admin', marketingOrgId)).id;
});

test.afterAll(async () => {
  for (const e of emails) await cleanupByEmail(e);
  await prisma.organization.deleteMany({ where: { id: marketingOrgId } });
  await prisma.$disconnect();
});

async function notifiedAbout(userId: string, types: string[], name: string) {
  const rows = await prisma.notification.findMany({
    where: { userId, type: { in: types } },
    select: { params: true },
  });
  return rows.some((r) => (r.params as { name?: string } | null)?.name === name);
}

test('an internship self-registration notifies the internship admins only', async ({ request }) => {
  const email = uniqueEmail('fanout-selfreg');
  emails.push(email);
  const fullName = `Fanout Signup ${Date.now()}`;
  const res = await request.post('/api/register', {
    headers: freshIp('admin-fanout register'),
    data: { email, password: PW, fullName },
  });
  expect(res.status()).toBe(201);

  const types = ['signup.new', 'signup.pendingApproval'];
  await expect.poll(() => notifiedAbout(internshipAdminId, types, fullName)).toBe(true);
  expect(await notifiedAbout(marketingAdminId, types, fullName)).toBe(false);
});

test('a mentor application notifies the internship admins only', async ({ request }) => {
  const email = uniqueEmail('fanout-mentor-app');
  emails.push(email);
  const fullName = `Fanout Applicant ${Date.now()}`;
  const res = await request.post('/api/mentor-applications', {
    headers: freshIp('admin-fanout mentor-app'),
    data: { fullName, email, motivation: 'Help.' },
  });
  expect(res.status()).toBe(200);

  const types = ['mentor_application.new'];
  await expect.poll(() => notifiedAbout(internshipAdminId, types, fullName)).toBe(true);
  expect(await notifiedAbout(marketingAdminId, types, fullName)).toBe(false);
  await prisma.mentorApplication.deleteMany({ where: { email } });
});

test('the marketing host files no mentor application — its product has no mentorship', async ({ request }) => {
  const email = uniqueEmail('fanout-mentor-app-mkt');
  const res = await request.post('/api/mentor-applications', {
    headers: { ...freshIp('admin-fanout mentor-app mkt'), 'x-forwarded-host': MARKETING_HOST },
    data: { fullName: 'Fanout Mkt Applicant', email, motivation: 'Help.' },
  });
  expect(res.status()).toBe(404);
  expect(await prisma.mentorApplication.count({ where: { email } })).toBe(0);
});
