import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { planLimits } from '../src/lib/orgPlans';
import { PLANS } from '../src/lib/plans';

// Every paywall gets a door — and the one wall a participant can walk into
// shows them none (#1745).
//
// A FREE tenant filled exactly to its cap:
//   • a mentor adding one more mentee gets the upgrade prompt with "your admin
//     has been notified", and the admins really get the notification;
//   • a prospective mentee applying through a mentor's link gets the capacity
//     answer — no plan name, no price, no upgrade — and the admins are told;
//   • a Turkish-language admin meets the locked analytics tier as a TURKISH
//     prompt whose request button files a real plan-change request.

const PW = 'UpgradePrompt123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('upgrade prompt for admin and mentor; the mentee path is commerce-free', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  // Seeds a full FREE tenant and walks three roles through four pages.
  test.setTimeout(240_000);
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Upgrade Org ${stamp}`, slug: `upgrade-${stamp}`, plan: 'FREE' } });
  const cap = planLimits('FREE').maxActiveRelations!;
  const emails = { admin: uniqueEmail('up-admin'), mentor: uniqueEmail('up-mentor'), open: uniqueEmail('up-open-mentor'), applicant: uniqueEmail('up-applicant') };
  const admin = await seedUser(emails.admin, PW, 'ADMIN', 'Upgrade Admin', { orgId: org.id });
  const mentor = await seedUser(emails.mentor, PW, 'MENTOR', 'Upgrade Mentor', { orgId: org.id });
  // A second mentor with no mentees, so the apply link reaches the PLAN gate
  // rather than this mentor's own capacity.
  const openMentor = await seedUser(emails.open, PW, 'MENTOR', 'Open Mentor', { orgId: org.id });

  const fillerIds: string[] = [];
  for (let i = 0; i < cap; i++) {
    const m = await prisma.user.create({
      data: { email: `upfill.${i}.${stamp}@import.local`, password: '!x', role: 'MENTEE', fullName: `Up Fill ${i}`, skills: [], orgId: org.id },
    });
    fillerIds.push(m.id);
    await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: m.id, orgId: org.id, status: 'ACTIVE' } });
  }

  const jars: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
  try {
    // ── The mentee path: capacity-shaped, commerce-free ──────────────────────
    const anon = await playwright.request.newContext({ baseURL });
    jars.push(anon);
    const apply = await anon.post('/api/apply', {
      headers: freshIp('up-apply'),
      data: { mentorId: openMentor.id, fullName: 'Hopeful Applicant', email: emails.applicant },
    });
    expect(apply.status()).toBe(409);
    const raw = await apply.text();
    expect(JSON.parse(raw).code).toBe('mentor_full');
    // No plan name (current or published), no price, no upgrade wording.
    for (const word of ['FREE', 'PRO', 'ENTERPRISE', 'plan', 'Plan', 'upgrade', 'Upgrade', '€', 'EUR', ...PLANS.map((p) => p.name)]) {
      expect(raw, `apply body leaks "${word}"`).not.toContain(word);
    }
    expect(await prisma.user.count({ where: { email: emails.applicant } })).toBe(0);
    await expect
      .poll(() => prisma.notification.count({ where: { userId: admin.id, type: 'plan_limit.reached' } }))
      .toBe(1);

    // ── The mentor path: the door, and the admins already told ──────────────
    const m = await playwright.request.newContext({ baseURL });
    jars.push(m);
    expect((await signInViaApi(m, emails.mentor, PW, { headers: freshIp('up-mentor') })).error).toBeNull();
    const add = await m.post('/api/mentor/mentees', { data: { fullName: 'One Too Many' } });
    expect(add.status()).toBe(403);
    const addBody = await add.json();
    expect(addBody.code).toBe('plan_limit_reached');
    expect(addBody.adminsNotified).toBe(true);
    // Deduplicated: the admin was told once in the window, not once per refusal.
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'plan_limit.reached' } })).toBe(1);

    expect((await signInViaApi(page.request, emails.mentor, PW, { headers: freshIp('up-mentor-ui') })).error).toBeNull();
    await gotoSettled(page, '/mentor/mentees/new');
    await page.locator('form input').first().fill('One Too Many');
    await page.locator('form button[type="submit"]').click();
    const mentorPrompt = page.getByTestId('upgrade-prompt');
    await expect(mentorPrompt).toBeVisible();
    await expect(mentorPrompt).toHaveAttribute('data-code', 'plan_limit_reached');
    await expect(mentorPrompt.getByTestId('upgrade-prompt-admin-note')).toHaveText('Your programme admin has been notified.');
    await expect(mentorPrompt.getByTestId('upgrade-prompt-request')).toHaveCount(0);
    // Nothing was cut off.
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id, status: 'ACTIVE' } })).toBe(cap);

    // ── A Turkish admin: a Turkish prompt with a working request ─────────────
    await page.context().clearCookies();
    await page.context().addCookies([{ name: 'locale', value: 'tr', url: baseURL! }]);
    expect((await signInViaApi(page.request, emails.admin, PW, { headers: freshIp('up-admin-ui') })).error).toBeNull();
    await gotoSettled(page, '/admin/analytics');
    const adminPrompt = page.getByTestId('premium-analytics-locked').getByTestId('upgrade-prompt');
    await expect(adminPrompt).toBeVisible({ timeout: 60_000 });
    await expect(adminPrompt.getByTestId('upgrade-prompt-blocked')).toContainText('planınıza dahil değil');
    await expect(adminPrompt.getByTestId('upgrade-prompt-offer')).toContainText('Program');
    await adminPrompt.getByTestId('upgrade-prompt-request').click();
    await expect(adminPrompt.getByTestId('upgrade-prompt-sent')).toBeVisible();
    const req = await prisma.planChangeRequest.findFirst({ where: { orgId: org.id, status: 'NEW' } });
    expect(req?.requestedPlan).toBe('program');
  } finally {
    for (const ctx of jars) await ctx.dispose();
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: fillerIds } } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
