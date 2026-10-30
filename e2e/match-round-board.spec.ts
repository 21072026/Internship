import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// The round board in the browser (#1796): open a round from the list, run it,
// read why someone is unmatched, swap one row from its alternatives, lock two,
// move to review and publish through the confirmation dialog (which states the
// count and that both sides are e-mailed) — exactly two relations exist after.
test('round board: run, swap, lock two, publish through the dialog', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'BoardUiPass123!';
  const org = await prisma.organization.create({ data: { name: `Board UI ${stamp}`, slug: `board-ui-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('board-ui-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Board UI Admin', org.id);
    const person = async (role: 'MENTOR' | 'MENTEE', name: string, skills: string[], data: Record<string, unknown> = {}) => {
      const u = await seedUser(uniqueEmail(`board-ui-${role.toLowerCase()}`), pw, role, name, org.id);
      return prisma.user.update({ where: { id: u.id }, data: { skills, ...data } });
    };
    const ada = await person('MENTOR', `Ada Mentor ${stamp}`, ['React'], { mentorCapacity: 5 });
    const bo = await person('MENTOR', `Bo Mentor ${stamp}`, ['React'], { mentorCapacity: 5 });
    const m1 = await person('MENTEE', `Mia Mentee ${stamp}`, ['React']);
    const m2 = await person('MENTEE', `Noa Mentee ${stamp}`, ['React']);
    const m3 = await person('MENTEE', `Cobol Mentee ${stamp}`, ['Cobol']);

    await signInAndSettle(page, adminEmail, pw, '/admin');
    await gotoSettled(page, '/admin/matching/rounds');
    await page.getByTestId('round-name').fill('Autumn board');
    await page.getByTestId('round-create').click();
    await page.waitForURL(/\/admin\/matching\/rounds\/[^/]+$/);
    await expect(page.getByTestId('round-title')).toHaveText('Autumn board');

    await page.getByTestId('round-run').click();
    await expect(page.getByTestId('round-stats')).toBeVisible();
    // Why the Cobol mentee has nobody.
    const unmatched = page.getByTestId('round-unmatched');
    await expect(unmatched).toContainText('No mentor scores high enough');
    await expect(unmatched).toContainText(m3.fullName);

    // Both React mentees are proposed one of the two React mentors (tie → id
    // order); swap Mia to the other one from her alternatives.
    const rows = await prisma.matchProposal.findMany({ where: { round: { orgId: org.id } } });
    const mia = rows.find((r) => r.menteeId === m1.id)!;
    const other = mia.mentorId === ada.id ? bo : ada;
    await page.getByTestId(`proposal-swap-${m1.id}`).click();
    await page.getByTestId(`swap-to-${other.id}`).click();
    await expect(page.getByTestId(`proposal-${m1.id}`)).toContainText(other.fullName);

    await page.getByTestId(`proposal-lock-${m1.id}`).click();
    await expect(page.getByTestId(`proposal-unlock-${m1.id}`)).toBeVisible();
    await page.getByTestId(`proposal-lock-${m2.id}`).click();
    await expect(page.getByTestId(`proposal-unlock-${m2.id}`)).toBeVisible();

    await page.getByTestId('round-to-review').click();
    await expect(page.getByTestId('round-publish')).toBeEnabled();
    await page.getByTestId('round-publish').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('2 mentorships will be created now');
    await expect(dialog).toContainText('by e-mail');
    await dialog.getByRole('button', { name: 'Create 2 mentorships' }).click();
    await expect(page.getByTestId('round-status')).toHaveText('Published');

    const relations = await prisma.mentorshipRelation.findMany({ where: { menteeId: { in: [m1.id, m2.id, m3.id] } } });
    expect(relations).toHaveLength(2);
    expect(relations.find((r) => r.menteeId === m1.id)?.mentorId).toBe(other.id);
  } finally {
    await prisma.matchDecision.deleteMany({ where: { orgId: org.id } });
    await prisma.matchRound.deleteMany({ where: { orgId: org.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
