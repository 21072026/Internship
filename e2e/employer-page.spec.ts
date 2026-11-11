import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The public employer page (#1867, docs/employer-page.md): a verified company
// publishes itself from its own profile and gets a Turkish-safe slug; the page
// lists only OPEN roles with a free seat and never the contact e-mail or the
// address; an opted-out or unverified company is a 404, not an empty page.

const PW = 'EmployerPage123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const companyName = `Şişecam Çağrı ${stamp}`;
const privateEmail = `private-${stamp}@acme.example`;
const privateAddress = `Geheimstraße ${stamp}`;
const emails = { owner: uniqueEmail('ep-owner'), pending: uniqueEmail('ep-pending') };
const ids: Record<string, string> = {};
let orgId: string;
let owner: APIRequestContext;

// The public page resolves the tenant from the host: localhost is the default org's.
async function defaultOrgId(): Promise<string> {
  const org = await prisma.organization.upsert({ where: { slug: 'default' }, update: {}, create: { slug: 'default', name: 'Default Organization' }, select: { id: true } });
  return org.id;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  orgId = await defaultOrgId();
  const hash = await bcrypt.hash(PW, 10);
  ids.company = (await prisma.company.create({ data: { orgId, name: companyName, contactEmail: privateEmail, address: privateAddress } })).id;
  ids.pending = (await prisma.company.create({ data: { orgId, name: `Pending Employer ${stamp}`, verificationStatus: 'PENDING', isPublicProfile: true, slug: `pending-employer-${stamp}` } })).id;
  await prisma.user.create({ data: { email: emails.owner, password: hash, role: 'COMPANY', orgId, companyId: ids.company, fullName: 'EP Owner', skills: [] } });
  const req = (key: string, data: Record<string, unknown>) =>
    prisma.requisition.create({ data: { orgId, companyId: ids.company, title: `${key} role ${stamp}`, openings: 1, requiredSkills: [], ...data } }).then((r) => { ids[key] = r.id; });
  await req('open', { status: 'OPEN', city: 'Berlin' });
  await req('draft', { status: 'DRAFT' });
  await req('full', { status: 'OPEN', filled: 1 });
  owner = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await signInViaApi(owner, emails.owner, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await owner?.dispose();
  await prisma.requisition.deleteMany({ where: { companyId: { in: [ids.company, ids.pending] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { id: { in: [ids.company, ids.pending] } } }).catch(() => {});
  await prisma.$disconnect();
});

test('an opted-out company has no page; publishing gives it a Turkish-safe slug', async ({ request }) => {
  // Not published yet: no slug, and nothing at the would-be address.
  expect((await prisma.company.findUniqueOrThrow({ where: { id: ids.company } })).slug).toBeNull();
  const res = await owner.put(`/api/companies/${ids.company}`, {
    data: { about: 'We make glass.\nAnd robots.', websiteUrl: 'https://acme.example/careers', isPublicProfile: true },
  });
  expect(res.status()).toBe(200);
  const slug = (await res.json()).company.slug as string;
  expect(slug).toBe(`sisecam-cagri-${stamp}`);

  // An unsafe website is refused.
  expect((await owner.put(`/api/companies/${ids.company}`, { data: { websiteUrl: 'javascript:alert(1)' } })).status()).toBe(400);
  // The slug is the server's.
  expect((await owner.put(`/api/companies/${ids.company}`, { data: { slug: 'mine' } })).status()).toBe(403);

  const api = await request.get(`/api/public/employers/${slug}`);
  expect(api.status()).toBe(200);
  const text = await api.text();
  expect(text).not.toContain(privateEmail);
  expect(text).not.toContain(privateAddress);
  const { employer } = JSON.parse(text);
  expect(employer).toMatchObject({ name: companyName, about: 'We make glass.\nAnd robots.', websiteUrl: 'https://acme.example/careers' });
  expect(employer.roles.map((r: { id: string }) => r.id)).toEqual([ids.open]);
});

test('the page renders the open roles only, without contact details', async ({ page }) => {
  const slug = (await prisma.company.findUniqueOrThrow({ where: { id: ids.company } })).slug!;
  await page.goto(`/employers/${slug}`);
  await expect(page.getByTestId('employer-page')).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(companyName));
  const roles = page.getByTestId('employer-roles');
  await expect(roles.getByRole('link', { name: `open role ${stamp}` })).toHaveAttribute('href', `/portal/jobs/${ids.open}`);
  await expect(roles.getByText(`draft role ${stamp}`)).toHaveCount(0);
  await expect(roles.getByText(`full role ${stamp}`)).toHaveCount(0);
  await expect(page.getByTestId('employer-website')).toHaveAttribute('rel', 'noopener nofollow');
  await expect(page.getByText(privateEmail)).toHaveCount(0);
  await expect(page.getByText(privateAddress)).toHaveCount(0);
});

test('an unverified or unpublished company is a 404, not an empty page', async ({ request, page }) => {
  expect((await request.get(`/api/public/employers/pending-employer-${stamp}`)).status()).toBe(404);
  const pageRes = await page.goto(`/employers/pending-employer-${stamp}`);
  expect(pageRes?.status()).toBe(404);

  const slug = (await prisma.company.findUniqueOrThrow({ where: { id: ids.company } })).slug!;
  expect((await owner.put(`/api/companies/${ids.company}`, { data: { isPublicProfile: false } })).status()).toBe(200);
  expect((await request.get(`/api/public/employers/${slug}`)).status()).toBe(404);
  // Re-publishing keeps the same address.
  const again = await owner.put(`/api/companies/${ids.company}`, { data: { isPublicProfile: true } });
  expect((await again.json()).company.slug).toBe(slug);
  expect((await request.get('/api/public/employers/no-such-employer')).status()).toBe(404);
});
