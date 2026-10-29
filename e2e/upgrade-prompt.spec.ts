import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import { planLimits } from '../src/lib/orgPlans';

// The upgrade prompt (#1745). A FREE tenant filled to its active-relation band:
//   1. a TURKISH admin assigning one more mentorship sees the shared prompt in
//      Turkish, with the plan that lifts the cap, its published price and the
//      request button — not the server's English `error` string;
//   2. FREE CORE: the public /apply response the applicant (a future mentee)
//      reads carries no plan name, price or limit — a capacity message only —
//      and the org's admins are notified instead.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a full FREE org: Turkish admin prompt, commerce-free /apply', async ({ page, request }) => {
  test.setTimeout(180_000);
  const pw = 'UpgradePrompt123';
  const adminEmail = uniqueEmail('upg-admin');
  const stamp = adminEmail.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `Upgrade Org ${stamp}`, slug: `upg-${stamp}`.slice(0, 60), plan: 'FREE' } });
  const cap = planLimits('FREE').maxActiveRelations!;

  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Upgrade Admin', org.id);
  await prisma.user.update({ where: { id: admin.id }, data: { preferredLanguage: 'tr' } });
  const fillerMentorEmail = uniqueEmail('upg-mentor');
  const linkMentorEmail = uniqueEmail('upg-link-mentor');
  const fillerMentor = await seedUser(fillerMentorEmail, 'x', 'MENTOR', 'Upgrade Filler Mentor', org.id);
  // A second mentor with room of their own: the cap that holds the application
  // is the ORG's plan, not the mentor's capacity.
  const linkMentor = await seedUser(linkMentorEmail, 'x', 'MENTOR', 'Upgrade Link Mentor', org.id);

  const menteeIds: string[] = [];
  for (let i = 0; i < cap; i++) {
    const m = await prisma.user.create({
      data: { email: `upgfill.${i}.${stamp}@import.local`, password: '!x', role: 'MENTEE', fullName: `Upgrade Fill ${i}`, skills: [], orgId: org.id },
    });
    menteeIds.push(m.id);
    await prisma.mentorshipRelation.create({ data: { mentorId: fillerMentor.id, menteeId: m.id, orgId: org.id, status: 'ACTIVE' } });
  }
  const overflow = await prisma.user.create({
    data: { email: `upgoverflow.${stamp}@import.local`, password: '!x', role: 'MENTEE', fullName: `Upgrade Overflow ${stamp}`, skills: [], orgId: org.id },
  });
  menteeIds.push(overflow.id);
  const applicantEmail = `upg-applicant.${stamp}@example.test`;

  try {
    // ── 2. The applicant's side first: no session, the public route. ──
    const res = await request.post('/api/apply', {
      data: { mentorId: linkMentor.id, fullName: 'Ada Applicant', email: applicantEmail },
    });
    expect(res.status()).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).code).toBe('program_full');
    // No plan name (catalogue or legacy), no price, no quota figure, no upsell.
    for (const forbidden of [/\bFREE\b/, /\bPRO\b/, /\bENTERPRISE\b/, /Community/, /\bProgram\b/, /Enterprise/, /€|EUR/, /\bplan\b/i, /upgrade/i, /price/i, /"limit"|"usage"/, new RegExp(`\\b${cap}\\b`)]) {
      expect(text, String(forbidden)).not.toMatch(forbidden);
    }
    // Nobody was created for a held application, and the admin heard why.
    expect(await prisma.user.count({ where: { email: applicantEmail } })).toBe(0);
    await expect
      .poll(() => prisma.notification.count({ where: { userId: admin.id, type: 'plan_limit.application_held' } }))
      .toBe(1);

    // ── 1. The Turkish admin assigns one more mentorship. ──
    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/mentorship');
    await page.getByRole('button', { name: 'Mentorluk ata' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // The pickers fill asynchronously; select by value once the option exists.
    const selects = dialog.locator('select');
    await expect(selects.nth(1).locator(`option[value="${overflow.id}"]`)).toHaveCount(1, { timeout: 20_000 });
    await selects.nth(0).selectOption(fillerMentor.id);
    await selects.nth(1).selectOption(overflow.id);
    await dialog.getByRole('button', { name: 'Ata', exact: true }).click();

    const prompt = dialog.getByTestId('upgrade-prompt');
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toHaveAttribute('data-gate', 'plan_limit_reached');
    await expect(prompt).toContainText('Paketinizin sınırına ulaştınız');
    await expect(prompt.getByTestId('upgrade-prompt-body')).toContainText(`${cap} aktif mentorluktan ${cap}`);
    await expect(prompt.getByTestId('upgrade-prompt-price')).toContainText('Program');
    await expect(prompt.getByTestId('upgrade-prompt-price')).toContainText('yıllık');
    await expect(prompt.getByTestId('upgrade-prompt-request')).toBeVisible();
    await expect(prompt.getByTestId('upgrade-prompt-pricing')).toHaveAttribute('href', '/pricing');
    // Never the server's English sentence.
    await expect(dialog).not.toContainText('Plan limit reached');

    // Nothing existing was touched.
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id, status: 'ACTIVE' } })).toBe(cap);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: admin.id } }).catch(() => {});
    await prisma.planChangeRequest.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const id of menteeIds) await prisma.user.delete({ where: { id } }).catch(() => {});
    for (const e of [fillerMentorEmail, linkMentorEmail, adminEmail, applicantEmail]) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
