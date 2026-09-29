import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * Which company a mentorship relation may point at, and who may change it (#2613).
 *
 * `companyId` was a free string on PUT /api/mentorship/[id] and POST
 * /api/mentorship. An owner could re-point their relation at any company of the
 * tenant (a MARKETING rep's /sales/accounts then opened it — that half lives in
 * marketing-sales-surface.spec.ts); an ADMIN could attach another tenant's
 * company and read its name back from the response, and an unknown id was a
 * foreign-key 500. The relation itself opened by id across tenants too.
 *
 * Both orgs are INTERNSHIP on purpose: the mentorship module is present, so the
 * owner's refusal here is the role rule, not a capability gate.
 */

const PASSWORD = 'RelCompany123!';
const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
const MARK = `RCG${stamp}`;
const email = (tag: string) => `rcg-${tag}-${stamp}@e2e.local`;

let orgA: { id: string };
let orgB: { id: string };
let users: Record<'aAdmin' | 'aMentor' | 'aMentee' | 'aMentee2' | 'bAdmin', { id: string; email: string }>;
let companyA: { id: string };
let companyA2: { id: string };
let companyB: { id: string };
let relationId: string;

test.beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  orgA = await prisma.organization.create({ data: { name: `RCG A ${stamp}`, slug: `rcg-a-${stamp}`, vertical: 'INTERNSHIP' } });
  orgB = await prisma.organization.create({ data: { name: `RCG B ${stamp}`, slug: `rcg-b-${stamp}`, vertical: 'INTERNSHIP' } });
  const mk = async (tag: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) => {
    const u = await prisma.user.create({
      data: {
        email: email(tag), password: hash, role, orgId, fullName: `${tag} ${stamp}`, skills: [], emailVerified: true, isActive: true,
        ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}),
      },
    });
    return { id: u.id, email: u.email };
  };
  users = {
    aAdmin: await mk('a-admin', 'ADMIN', orgA.id),
    aMentor: await mk('a-mentor', 'MENTOR', orgA.id),
    aMentee: await mk('a-mentee', 'MENTEE', orgA.id),
    aMentee2: await mk('a-mentee2', 'MENTEE', orgA.id),
    bAdmin: await mk('b-admin', 'ADMIN', orgB.id),
  };
  companyA = await prisma.company.create({ data: { name: `${MARK} Own`, orgId: orgA.id } });
  companyA2 = await prisma.company.create({ data: { name: `${MARK} Other Own`, orgId: orgA.id } });
  companyB = await prisma.company.create({ data: { name: `${MARK} Foreign Secret`, orgId: orgB.id } });
  relationId = (await prisma.mentorshipRelation.create({
    data: { mentorId: users.aMentor.id, menteeId: users.aMentee.id, orgId: orgA.id, companyId: companyA.id },
  })).id;
});

test.afterAll(async () => {
  const ids = Object.values(users ?? {}).map((u) => u.id);
  await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ mentorId: { in: ids } }, { menteeId: { in: ids } }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.activityLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA?.id, orgB?.id].filter(Boolean) as string[] } } });
});

async function call(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, data, timeout: 120_000 });
  return { status: res.status(), body: await res.text() };
}

async function companyOfRelation() {
  return (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).companyId;
}

test('the owner cannot re-point their relation at another company', async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, users.aMentor.email, PASSWORD, '/mentor');

  for (const target of [companyA2.id, companyB.id, 'no-such-company', null]) {
    const r = await call(page, 'PUT', `/api/mentorship/${relationId}`, { companyId: target });
    expect(r.status, String(target)).toBe(403);
    expect(JSON.parse(r.body).code).toBe('company_change_admin_only');
    expect(r.body).not.toContain(MARK);
  }
  // Echoing the current company is a no-op, so a client that sends the whole
  // form back keeps working; the rest of the owner's edit goes through.
  const echo = await call(page, 'PUT', `/api/mentorship/${relationId}`, { companyId: companyA.id, nextActionNote: 'call back' });
  expect(echo.status).toBe(200);
  expect(await companyOfRelation()).toBe(companyA.id);
});

test("an admin cannot attach another tenant's company, and learns nothing about it", { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, users.aAdmin.email, PASSWORD, '/admin');

  // Another tenant's company and one that does not exist answer the same body.
  const foreign = await call(page, 'PUT', `/api/mentorship/${relationId}`, { companyId: companyB.id });
  const unknown = await call(page, 'PUT', `/api/mentorship/${relationId}`, { companyId: `c${stamp}missing` });
  expect(foreign.status).toBe(404);
  expect(unknown.status).toBe(404);
  expect(foreign.body).toBe(unknown.body);
  expect(foreign.body).not.toContain(MARK);
  expect(await companyOfRelation()).toBe(companyA.id);

  // POST had no check at all: the same refusal, and no relation is created.
  for (const companyId of [companyB.id, `c${stamp}missing`]) {
    const r = await call(page, 'POST', '/api/mentorship', { mentorId: users.aMentor.id, menteeId: users.aMentee2.id, companyId });
    expect(r.status, companyId).toBe(404);
    expect(r.body).toBe(unknown.body);
  }
  expect(await prisma.mentorshipRelation.count({ where: { menteeId: users.aMentee2.id } })).toBe(0);

  // The admin flow inside the tenant is unchanged: re-point, then clear.
  const moved = await call(page, 'PUT', `/api/mentorship/${relationId}`, { companyId: companyA2.id });
  expect(moved.status).toBe(200);
  expect(JSON.parse(moved.body).relation.company).toEqual({ id: companyA2.id, name: `${MARK} Other Own` });
  const cleared = await call(page, 'PUT', `/api/mentorship/${relationId}`, { companyId: null });
  expect(cleared.status).toBe(200);
  expect(await companyOfRelation()).toBeNull();
  await prisma.mentorshipRelation.update({ where: { id: relationId }, data: { companyId: companyA.id } });
});

test("another tenant's admin cannot open or edit the relation by id", async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, users.bAdmin.email, PASSWORD, '/admin');
  const read = await call(page, 'GET', `/api/mentorship/${relationId}`);
  expect(read.status).toBe(404);
  expect(read.body).not.toContain(MARK);
  expect(read.body).not.toContain(users.aMentee.email);
  const write = await call(page, 'PUT', `/api/mentorship/${relationId}`, { companyId: companyB.id, nextActionNote: 'planted' });
  expect(write.status).toBe(404);
  const row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(row.companyId).toBe(companyA.id);
  expect(row.nextActionNote).not.toBe('planted');
});
