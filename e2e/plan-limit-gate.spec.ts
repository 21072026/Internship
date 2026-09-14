import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { planLimits } from '../src/lib/orgPlans';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Plan-limit gate (#547): a FREE-plan tenant is blocked from adding a NEW active
// relation past its limit, while existing relations stay untouched; an
// unlimited (ENTERPRISE) tenant is never gated. Drives the admin create API.
test('FREE tenant is gated on new active relations; existing are unaffected', async ({ page }) => {
  const adminEmail = uniqueEmail('gate-admin');
  const pw = 'GatePass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Gate Admin');
  const org = await prisma.organization.create({ data: { name: `Gate Org ${adminEmail}`, slug: `gate-${adminEmail.replace(/[^a-z0-9]/gi, '').toLowerCase()}`, plan: 'FREE' } });
  const cap = planLimits('FREE').maxActiveRelations!;

  const mentor = await seedUser(uniqueEmail('gate-mentor'), 'x', 'MENTOR', 'Gate Mentor');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId: org.id } });
  await prisma.user.update({ where: { id: mentor.id }, data: { orgId: org.id } });

  // Fill the org exactly to the FREE cap. Create filler mentees directly (no
  // bcrypt) for speed, each with its own ACTIVE relation.
  const stamp = adminEmail.replace(/[^a-z0-9]/gi, '');
  const menteeIds: string[] = [];
  for (let i = 0; i < cap; i++) {
    const m = await prisma.user.create({
      data: { email: `gatefill.${i}.${stamp}@import.local`, password: '!x', role: 'MENTEE', fullName: `Gate Fill ${i}`, skills: [], orgId: org.id },
    });
    menteeIds.push(m.id);
    await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: m.id, orgId: org.id, status: 'ACTIVE' } });
  }
  // The mentee we'll try (and fail) to add — same FREE org.
  const overflow = await prisma.user.create({
    data: { email: `gateoverflow.${stamp}@import.local`, password: '!x', role: 'MENTEE', fullName: 'Gate Overflow', skills: [], orgId: org.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Adding one more active relation is blocked at the plan cap.
    const res = await page.request.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: overflow.id } });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('plan_limit_reached');
    expect(body.limit).toBe(cap);

    // Existing relations are all still there — nothing was hard-cut.
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id, status: 'ACTIVE' } })).toBe(cap);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const id of [...menteeIds, overflow.id]) await prisma.user.delete({ where: { id } }).catch(() => {});
    await cleanupByEmail(mentor.email);
    await cleanupByEmail(adminEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

// The project cap (#2273). `maxProjects` had been declared in the plan
// catalogue since #547 and read by exactly one thing — the usage gauge on
// /admin/organizations — so the number was shown and never enforced. #2270 then
// opened project creation to the largest role population there is.
//
// Asserted from the MENTEE side on purpose: that is the role #2270 opened, the
// one that makes unbounded growth per tenant the default rather than a
// theoretical case, and the one whose client-side brake (a per-user rate limit
// with an in-process counter) is explicitly not a quota.
test('FREE tenant is gated on new projects; existing projects are unaffected', async ({ page }) => {
  const pw = 'ProjectCapPass123';
  const menteeEmail = uniqueEmail('projcap-mentee');
  const stamp = menteeEmail.replace(/[^a-z0-9]/gi, '');
  const org = await prisma.organization.create({
    data: { name: `Project Cap Org ${stamp}`, slug: `projcap-${stamp}`.slice(0, 60), plan: 'FREE' },
  });
  const cap = planLimits('FREE').maxProjects!;
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Project Cap Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id } });

  try {
    // Fill the org exactly to the cap, directly — the gate is about what the
    // tenant HOLDS, not about how the rows got there.
    for (let i = 0; i < cap; i++) {
      await prisma.project.create({
        data: { orgId: org.id, name: `Cap Filler ${i} ${stamp}`, ownerType: 'MENTEE', ownerUserId: mentee.id, technologies: [] },
      });
    }

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const res = await page.request.post('/api/projects', { data: { name: `Cap Overflow ${stamp}` } });
    expect(res.status()).toBe(403);
    const body = await res.json();
    // Its OWN code, not the relation gate's: a client that maps
    // 'plan_limit_reached' renders a sentence about active mentorships, which
    // would be confidently wrong here.
    expect(body.code).toBe('project_limit_reached');
    expect(body.limit).toBe(cap);
    expect(body.usage).toBe(cap);
    expect(body.plan).toBe('FREE');

    // Nothing was created, and nothing existing was touched.
    expect(await prisma.project.count({ where: { orgId: org.id } })).toBe(cap);
    expect(await prisma.project.count({ where: { name: `Cap Overflow ${stamp}` } })).toBe(0);
  } finally {
    await prisma.projectMember.deleteMany({ where: { project: { orgId: org.id } } });
    await prisma.project.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(menteeEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

// An unlimited plan is never gated — the grandfathered `default` org is
// ENTERPRISE, so this is what makes the change a no-op on the live install.
test('ENTERPRISE tenant is not gated on projects', async ({ page }) => {
  const pw = 'ProjectCapPass123';
  const menteeEmail = uniqueEmail('projcap-ent-mentee');
  const stamp = menteeEmail.replace(/[^a-z0-9]/gi, '');
  const org = await prisma.organization.create({
    data: { name: `Project Cap Ent ${stamp}`, slug: `projcapent-${stamp}`.slice(0, 60), plan: 'ENTERPRISE' },
  });
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Project Cap Ent Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id } });

  try {
    // Past what FREE would allow, so a gate that ignored the plan would fire.
    for (let i = 0; i < planLimits('FREE').maxProjects! + 1; i++) {
      await prisma.project.create({
        data: { orgId: org.id, name: `Ent Filler ${i} ${stamp}`, ownerType: 'MENTEE', ownerUserId: mentee.id, technologies: [] },
      });
    }

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const res = await page.request.post('/api/projects', { data: { name: `Ent Overflow ${stamp}` } });
    expect(res.status()).toBe(201);
  } finally {
    await prisma.projectMember.deleteMany({ where: { project: { orgId: org.id } } });
    await prisma.project.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(menteeEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
