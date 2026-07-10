import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('talent-pool is gated by the entitlement and only surfaces public-profile mentees', async ({ page }) => {
  const companyEmail = uniqueEmail('tp-co');
  const pw = 'TalentPass123';
  const company = await prisma.company.create({ data: { name: `Talent Co ${Date.now()}` } });
  await prisma.user.create({
    data: { email: companyEmail, password: await bcrypt.hash(pw, 10), role: 'COMPANY', fullName: 'Talent Co Observer', companyId: company.id, skills: [] },
  });

  const publicEmail = uniqueEmail('tp-public');
  const privateEmail = uniqueEmail('tp-private');
  const noConsentEmail = uniqueEmail('tp-noconsent');
  const publicMentee = await seedUser(publicEmail, 'x', 'MENTEE', 'Ada Public');
  const privateMentee = await seedUser(privateEmail, 'x', 'MENTEE', 'Bob Private');
  // Public profile but no TALENT_POOL_VISIBILITY consent → must stay hidden (#527).
  const noConsentMentee = await seedUser(noConsentEmail, 'x', 'MENTEE', 'Cem NoConsent');
  await prisma.user.update({ where: { id: publicMentee.id }, data: { publicProfile: true, university: 'MIT', skills: ['React'] } });
  await prisma.user.update({ where: { id: privateMentee.id }, data: { publicProfile: false, university: 'MIT', skills: ['React'] } });
  await prisma.user.update({ where: { id: noConsentMentee.id }, data: { publicProfile: true, university: 'MIT', skills: ['React'] } });
  await prisma.userConsent.create({ data: { userId: publicMentee.id, type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', companyEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });

    // Without the entitlement the API is locked (403).
    const locked = await page.request.get('/api/company/talent-pool');
    expect(locked.status()).toBe(403);

    // Grant the entitlement.
    await prisma.companyEntitlement.create({ data: { companyId: company.id, feature: 'TALENT_POOL_SEARCH' } });

    // Now it returns results — the consenting public-profile mentee, but not
    // the private one, and not the public-but-unconsenting one (#527).
    const ok = await page.request.get('/api/company/talent-pool');
    expect(ok.ok()).toBeTruthy();
    const ids = ((await ok.json()).candidates as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(publicMentee.id);
    expect(ids).not.toContain(privateMentee.id);
    expect(ids).not.toContain(noConsentMentee.id);

    // Revoking the consent removes the mentee from company search immediately.
    await prisma.userConsent.update({
      where: { userId_type: { userId: publicMentee.id, type: 'TALENT_POOL_VISIBILITY' } },
      data: { revokedAt: new Date() },
    });
    const afterRevoke = await page.request.get('/api/company/talent-pool');
    const idsAfter = ((await afterRevoke.json()).candidates as { id: string }[]).map((c) => c.id);
    expect(idsAfter).not.toContain(publicMentee.id);
  } finally {
    await prisma.companyEntitlement.deleteMany({ where: { companyId: company.id } });
    await cleanupByEmail(companyEmail);
    await cleanupByEmail(publicEmail);
    await cleanupByEmail(privateEmail);
    await cleanupByEmail(noConsentEmail);
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
  }
});
