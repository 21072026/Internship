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
