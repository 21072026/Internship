import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

/**
 * Projects across two tenants (#2622).
 *
 * With MT_ENFORCE_ISOLATION off (every deployment today) the org middleware
 * scopes nothing, and every project rule answers true for any ADMIN. So an
 * admin of one org listed every org's projects, and could read, edit, delete
 * and manage the roster, join requests and goals of another org's project by
 * id; the /projects/[id] page gave them the full internal view. The routes now
 * answer another tenant's project exactly like a missing one, and the page
 * reads a signed-in visitor from another tenant like an anonymous one.
 *
 * Both orgs are INTERNSHIP, so the `projects` capability is on for both and
 * the refusals here are the tenant check, not a capability gate.
 */

const PASSWORD = 'CrossProj123!';
const stamp = `${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
const MARK = `XPRJ${stamp}`;
const email = (tag: string) => `xprj-${tag}-${stamp}@e2e.local`;

let orgA: { id: string };
let orgB: { id: string };
let users: Record<'aAdmin' | 'aMentor' | 'aMentee' | 'bAdmin' | 'bMentee', { id: string; email: string; fullName: string }>;
let privateA: { id: string };
let publicA: { id: string };
let ownB: { id: string };

test.beforeAll(async () => {
  const hash = await bcrypt.hash(PASSWORD, 10);
  orgA = await prisma.organization.create({ data: { name: `XPrj A ${stamp}`, slug: `xprj-a-${stamp}`, vertical: 'INTERNSHIP' } });
  orgB = await prisma.organization.create({ data: { name: `XPrj B ${stamp}`, slug: `xprj-b-${stamp}`, vertical: 'INTERNSHIP' } });
  const mk = async (tag: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) => {
    const fullName = `${MARK} ${tag}`;
    const u = await prisma.user.create({
      data: {
        email: email(tag), password: hash, role, orgId, fullName, skills: [], emailVerified: true, isActive: true,
        ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}),
      },
    });
    return { id: u.id, email: u.email, fullName };
  };
  users = {
    aAdmin: await mk('a-admin', 'ADMIN', orgA.id),
    aMentor: await mk('a-mentor', 'MENTOR', orgA.id),
    aMentee: await mk('a-mentee', 'MENTEE', orgA.id),
    bAdmin: await mk('b-admin', 'ADMIN', orgB.id),
    bMentee: await mk('b-mentee', 'MENTEE', orgB.id),
  };
  const project = (name: string, orgId: string, ownerUserId: string, isPublic: boolean) =>
    prisma.project.create({ data: { name: `${MARK} ${name}`, ownerType: 'ADMIN', ownerUserId, orgId, isPublic } });
  privateA = await project('Private A', orgA.id, users.aAdmin.id, false);
  publicA = await project('Public A', orgA.id, users.aAdmin.id, true);
  ownB = await project('Own B', orgB.id, users.bAdmin.id, false);
  for (const p of [privateA, publicA]) {
    await prisma.projectMember.createMany({
      data: [
        { projectId: p.id, userId: users.aAdmin.id, role: 'OWNER' },
        { projectId: p.id, userId: users.aMentee.id, role: 'MENTEE' },
      ],
    });
  }
});

test.afterAll(async () => {
  const ids = Object.values(users ?? {}).map((u) => u.id);
  const projects = { name: { startsWith: MARK } };
  await prisma.projectTask.deleteMany({ where: { OR: [{ project: projects }, { assigneeId: { in: ids } }] } });
  await prisma.projectTaskTemplate.deleteMany({ where: { project: projects } });
  await prisma.projectJoinRequest.deleteMany({ where: { project: projects } });
  await prisma.projectMember.deleteMany({ where: { project: projects } });
  await prisma.project.deleteMany({ where: projects });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.activityLog.deleteMany({ where: { actorId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.organization.deleteMany({ where: { id: { in: [orgA?.id, orgB?.id].filter(Boolean) as string[] } } });
});

async function call(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, data, timeout: 120_000 });
  return { status: res.status(), body: await res.text() };
}

async function snapshot(id: string) {
  const p = await prisma.project.findUnique({
    where: { id },
    select: { name: true, isPublic: true, members: { select: { userId: true, role: true }, orderBy: { userId: 'asc' } } },
  });
  const [tasks, templates, requests] = await Promise.all([
    prisma.projectTask.count({ where: { projectId: id } }),
    prisma.projectTaskTemplate.count({ where: { projectId: id } }),
    prisma.projectJoinRequest.count({ where: { projectId: id } }),
  ]);
  return { p, tasks, templates, requests };
}

test("another tenant's admin gets not-found on every project route, and changes nothing", { tag: '@smoke' }, async ({ page }) => {
  test.setTimeout(300_000);
  await signInAsFreshUser(page, users.bAdmin.email, PASSWORD, '/admin');
  const before = await snapshot(privateA.id);

  // The list is the caller's tenant only — their own project is there.
  const list = await call(page, 'GET', '/api/projects');
  expect(list.status).toBe(200);
  expect(list.body).toContain(`${MARK} Own B`);
  expect(list.body).not.toContain(`${MARK} Private A`);
  expect(list.body).not.toContain(`${MARK} Public A`);
  // The control: their own project opens by id, so the 404s below are the
  // tenant check and not a broken route.
  expect((await call(page, 'GET', `/api/projects/${ownB.id}`)).status).toBe(200);

  const id = privateA.id;
  const probes: Array<[string, string, unknown?]> = [
    ['GET', `/api/projects/${id}`],
    ['PUT', `/api/projects/${id}`, { name: 'planted', isPublic: true }],
    ['GET', `/api/projects/${id}/members`],
    ['POST', `/api/projects/${id}/members`, { userId: users.bMentee.id, role: 'MENTEE' }],
    ['DELETE', `/api/projects/${id}/members`, { userId: users.aMentee.id }],
    ['GET', `/api/projects/${id}/join-requests`],
    ['POST', `/api/projects/${id}/join-requests`, {}],
    ['PATCH', `/api/projects/${id}/join-requests`, { requestId: 'none', decision: 'APPROVED' }],
    ['GET', `/api/projects/${id}/task-templates`],
    ['POST', `/api/projects/${id}/task-templates`, { translations: { en: 'planted' } }],
    ['PATCH', `/api/projects/${id}/task-templates`, { id: 'none', translations: { en: 'planted' } }],
    ['DELETE', `/api/projects/${id}/task-templates`, { id: 'none' }],
    ['POST', `/api/projects/${id}/tasks`, { title: 'planted' }],
    ['DELETE', `/api/projects/${id}`],
  ];
  for (const [method, url, data] of probes) {
    const r = await call(page, method, url, data);
    expect(r.status, `${method} ${url}`).toBe(404);
    expect(r.body, `${method} ${url}`).not.toContain(MARK);
  }
  // The same body as a project that does not exist: no existence oracle.
  const missing = await call(page, 'GET', `/api/projects/x${stamp}missing`);
  expect((await call(page, 'GET', `/api/projects/${id}`)).body).toBe(missing.body);

  expect(await snapshot(privateA.id)).toEqual(before);

  // The page: a private project is a 404, a public one the anonymous stub —
  // no roster, no admin panels.
  expect((await page.request.get(`/projects/${privateA.id}`)).status()).toBe(404);
  const pub = await page.request.get(`/projects/${publicA.id}`);
  expect(pub.status()).toBe(200);
  const html = await pub.text();
  expect(html).toContain(`${MARK} Public A`);
  expect(html).not.toContain(users.aMentee.fullName);
});

test("an admin cannot put another tenant's user on their project; their own tenant's still works", async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, users.aAdmin.email, PASSWORD, '/admin');
  const foreign = await call(page, 'POST', `/api/projects/${privateA.id}/members`, { userId: users.bMentee.id, role: 'MENTEE' });
  expect(foreign.status).toBe(400);
  expect(foreign.body).not.toContain(MARK);
  expect(await prisma.projectMember.count({ where: { projectId: privateA.id, userId: users.bMentee.id } })).toBe(0);

  const own = await call(page, 'POST', `/api/projects/${privateA.id}/members`, { userId: users.aMentor.id, role: 'MENTOR' });
  expect(own.status, own.body).toBeLessThan(300);
  expect(await prisma.projectMember.count({ where: { projectId: privateA.id, userId: users.aMentor.id } })).toBe(1);

  // The in-tenant admin keeps the full view: the project, its roster, the page.
  const read = await call(page, 'GET', `/api/projects/${privateA.id}`);
  expect(read.status).toBe(200);
  expect(read.body).toContain(users.aMentee.fullName);
  const pageRes = await page.request.get(`/projects/${privateA.id}`);
  expect(pageRes.status()).toBe(200);
  expect(await pageRes.text()).toContain(users.aMentee.fullName);
  const list = await call(page, 'GET', '/api/projects');
  expect(list.body).toContain(`${MARK} Private A`);
  expect(list.body).not.toContain(`${MARK} Own B`);
});

test("a mentee lists only their own tenant's public projects", async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, users.bMentee.email, PASSWORD, '/portal');
  const list = await call(page, 'GET', '/api/projects');
  expect(list.status).toBe(200);
  expect(list.body).not.toContain(`${MARK} Public A`);
  // …and cannot ask to join one by id.
  const join = await call(page, 'POST', `/api/projects/${publicA.id}/join-requests`, {});
  expect(join.status).toBe(404);
  expect(await prisma.projectJoinRequest.count({ where: { projectId: publicA.id } })).toBe(0);
});

test("a new project lands in its creator's tenant, and cannot be owned by another tenant", async ({ page }) => {
  test.slow();
  await signInAsFreshUser(page, users.bAdmin.email, PASSWORD, '/admin');
  // Stamped with the creator's org even with the flag off — a NULL org would be
  // the default org's, and vanish from this admin's own list.
  const created = await call(page, 'POST', '/api/projects', { name: `${MARK} Created B`, ownerType: 'ADMIN' });
  expect(created.status, created.body).toBeLessThan(300);
  const row = await prisma.project.findFirstOrThrow({ where: { name: `${MARK} Created B` } });
  expect(row.orgId).toBe(orgB.id);
  expect((await call(page, 'GET', '/api/projects')).body).toContain(`${MARK} Created B`);
  expect((await call(page, 'GET', `/api/projects/${row.id}`)).status).toBe(200);

  // Another tenant's user or company as the owner is no owner at all.
  const foreignCompany = await prisma.company.create({ data: { name: `${MARK} Foreign Co`, orgId: orgA.id } });
  try {
    for (const body of [
      { name: `${MARK} Planted 1`, ownerType: 'ADMIN', ownerUserId: users.aAdmin.id },
      { name: `${MARK} Planted 2`, ownerType: 'MENTEE', ownerUserId: users.aMentee.id },
      { name: `${MARK} Planted 3`, ownerType: 'COMPANY', ownerCompanyId: foreignCompany.id },
    ]) {
      const r = await call(page, 'POST', '/api/projects', body);
      expect(r.status, body.ownerType).toBe(400);
      expect(r.body).not.toContain(MARK);
    }
    expect(await prisma.project.count({ where: { name: { startsWith: `${MARK} Planted` } } })).toBe(0);
    const repoint = await call(page, 'PUT', `/api/projects/${row.id}`, { ownerType: 'MENTEE', ownerUserId: users.aMentee.id });
    expect(repoint.status).toBe(400);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: row.id } })).ownerUserId).toBe(users.bAdmin.id);
  } finally {
    await prisma.company.delete({ where: { id: foreignCompany.id } });
  }
});
