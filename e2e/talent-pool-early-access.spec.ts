import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });
}

// Premium Faz 1 (#531): a candidate who became hireable (HIREABLE_600) within
// the early-access window is visible in talent-pool search ONLY to companies
// holding the EARLY_ACCESS entitlement; other subscribers see them once the
// window (default 7 days) has passed. Uses the default window — no global
// Setting mutation — so it is safe under parallel workers.
test('early-access window hides newly-hireable candidates from non-premium subscribers', async ({ browser }) => {
  const stamp = `${Date.now()}`;
  const pw = 'EarlyPass123';
  const hash = await bcrypt.hash(pw, 10);
  const position = `Embedded Engineer ${stamp}`; // unique query term for both mentees

  const basicEmail = uniqueEmail('ea-basic');
  const premiumEmail = uniqueEmail('ea-premium');
  const mentorEmail = uniqueEmail('ea-mentor');
  const recentEmail = uniqueEmail('ea-recent');
  const oldEmail = uniqueEmail('ea-old');

  // basic company: talent-pool but NO early access. premium: both.
  const basicCo = await prisma.company.create({
    data: { name: `EA Basic ${stamp}`, entitlements: { create: { feature: 'TALENT_POOL_SEARCH' } } },
  });
  const premiumCo = await prisma.company.create({
    data: {
      name: `EA Premium ${stamp}`,
      entitlements: { create: [{ feature: 'TALENT_POOL_SEARCH' }, { feature: 'EARLY_ACCESS' }] },
    },
  });
  await prisma.user.create({ data: { email: basicEmail, password: hash, role: 'COMPANY', fullName: 'EA Basic User', skills: [], companyId: basicCo.id } });
  await prisma.user.create({ data: { email: premiumEmail, password: hash, role: 'COMPANY', fullName: 'EA Premium User', skills: [], companyId: premiumCo.id } });
  const mentor = await prisma.user.create({ data: { email: mentorEmail, password: hash, role: 'MENTOR', fullName: 'EA Mentor', skills: [] } });

  // recentMentee: became hireable just now → inside the window.
  const recentMentee = await prisma.user.create({
    data: { email: recentEmail, password: hash, role: 'MENTEE', fullName: `EA Recent ${stamp}`, skills: [], publicProfile: true, targetPosition: position },
  });
  // oldMentee: became hireable 30 days ago → window has passed.
  const oldMentee = await prisma.user.create({
    data: { email: oldEmail, password: hash, role: 'MENTEE', fullName: `EA Old ${stamp}`, skills: [], publicProfile: true, targetPosition: position },
  });

  const recentRel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: recentMentee.id, pipelineStatus: 'HIREABLE_600' } });
  const oldRel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: oldMentee.id, pipelineStatus: 'HIREABLE_600' } });
  await prisma.statusChange.create({
    data: { relationId: recentRel.id, fromStatus: 'JOB_SEEKING_500', toStatus: 'HIREABLE_600', changedById: mentor.id },
  });
  await prisma.statusChange.create({
    data: { relationId: oldRel.id, fromStatus: 'JOB_SEEKING_500', toStatus: 'HIREABLE_600', changedById: mentor.id, createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
  });

  const query = `/api/company/talent-pool?q=${encodeURIComponent(position)}`;
  const basicCtx = await browser.newContext();
  const premiumCtx = await browser.newContext();

  try {
    // Non-premium subscriber: sees the candidate whose window closed, NOT the fresh one.
    const basicPage = await basicCtx.newPage();
    await signIn(basicPage, basicEmail, pw);
    const basicRes = await basicPage.request.get(query);
    expect(basicRes.ok()).toBeTruthy();
    const basicIds = ((await basicRes.json()).candidates as { id: string }[]).map((c) => c.id);
    expect(basicIds).toContain(oldMentee.id);
    expect(basicIds).not.toContain(recentMentee.id);

    // Premium (early-access) subscriber: sees both.
    const premiumPage = await premiumCtx.newPage();
    await signIn(premiumPage, premiumEmail, pw);
    const premiumRes = await premiumPage.request.get(query);
    expect(premiumRes.ok()).toBeTruthy();
    const premiumIds = ((await premiumRes.json()).candidates as { id: string }[]).map((c) => c.id);
    expect(premiumIds).toContain(oldMentee.id);
    expect(premiumIds).toContain(recentMentee.id);
  } finally {
    await basicCtx.close();
    await premiumCtx.close();
    await prisma.statusChange.deleteMany({ where: { relationId: { in: [recentRel.id, oldRel.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [recentRel.id, oldRel.id] } } });
    await cleanupByEmail(recentEmail);
    await cleanupByEmail(oldEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(basicEmail);
    await cleanupByEmail(premiumEmail);
    await prisma.companyEntitlement.deleteMany({ where: { companyId: { in: [basicCo.id, premiumCo.id] } } });
    await prisma.company.delete({ where: { id: basicCo.id } }).catch(() => {});
    await prisma.company.delete({ where: { id: premiumCo.id } }).catch(() => {});
  }
});
