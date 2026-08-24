// #1272 — registration must assign the tenant at creation time. Before this,
// every account was created org-less and fail-closed org scoping (#1227)
// 403'd invited COMPANY users' portals until the next deploy's backfill.
import { test, expect } from '@playwright/test';
import { prisma, uniqueEmail, cleanupByEmail } from './helpers/db';

const PASSWORD = 'RegisterOrg123!';
const emails: string[] = [];
let orgId = '';

test.beforeAll(async () => {
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  orgId = org.id;
});

test.afterAll(async () => {
  for (const e of emails) await cleanupByEmail(e);
  await prisma.$disconnect();
});

test('invited registration inherits the invitation’s org immediately', async ({ request }) => {
  const email = uniqueEmail('invited-org');
  emails.push(email);
  const invite = await prisma.invitationToken.create({
    data: {
      token: `org-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      email,
      role: 'MENTEE',
      expiresAt: new Date(Date.now() + 86_400_000),
      orgId,
    },
  });
  const res = await request.post('/api/register', {
    data: { token: invite.token, email, password: PASSWORD, fullName: 'Invited OrgUser' },
  });
  expect(res.status()).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { orgId: true } });
  expect(user?.orgId).toBe(orgId);
});

test('token-less self-registration gets the default org, not null', async ({ request }) => {
  const email = uniqueEmail('selfreg-org');
  emails.push(email);
  const res = await request.post('/api/register', {
    data: { email, password: PASSWORD, fullName: 'SelfReg OrgUser' },
  });
  expect(res.status()).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { orgId: true } });
  expect(user?.orgId).toBe(orgId);
});

test('a legacy invitation without an org still registers (falls back to default org)', async ({ request }) => {
  const email = uniqueEmail('legacy-invite-org');
  emails.push(email);
  const invite = await prisma.invitationToken.create({
    data: {
      token: `org-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      email,
      role: 'MENTEE',
      expiresAt: new Date(Date.now() + 86_400_000),
      // orgId deliberately unset — pre-#1272 rows look like this
    },
  });
  const res = await request.post('/api/register', {
    data: { token: invite.token, email, password: PASSWORD, fullName: 'Legacy Invite OrgUser' },
  });
  expect(res.status()).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { orgId: true } });
  expect(user?.orgId).toBe(orgId);
});
