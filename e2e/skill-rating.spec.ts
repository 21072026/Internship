import { test, expect } from '@playwright/test';
import {
  prisma,
  seedUser,
  cleanupByEmail,
  uniqueEmail,
  seedMenteeWithRelation,
  cleanupMenteeWithRelation,
} from './helpers/db';
import { signInViaApi } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Skill self-assessment uses a 1–5 star picker; clicking a star persists that level.
test('mentee sets a skill level with the star rating and it persists', async ({ page }) => {
  const email = uniqueEmail('skillrate-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Skill Rate Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/profile');
    // Enter a skill so its rating row appears (the SkillsField chip editor, #2314 —
    // a plain `input[name="skills"]` no longer exists on this page).
    const skillsInput = page.getByTestId('skills-field-input');
    await skillsInput.fill('React');
    await skillsInput.press('Enter');
    // React's rating group; click the 4/5 star.
    const group = page.getByRole('radiogroup', { name: 'React' });
    await expect(group).toBeVisible({ timeout: 10_000 });
    await group.getByRole('radio', { name: '4/5' }).click();
    await expect(group.getByRole('radio', { name: '4/5' })).toHaveAttribute('aria-checked', 'true');

    // Save and confirm persistence.
    await page.getByRole('button', { name: /^(Save|Save changes|Kaydet)/i }).first().click();
    await expect(async () => {
      const me = await (await page.request.get('/api/profile')).json();
      expect(me.user.skillLevels?.React).toBe(4);
    }).toPass({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});

// Proficiency on the canonical row (#1822): the self-assessment lands on the
// UserSkill row with exactly one history entry per actual change; only the
// mentor of the ACTIVE pair may confirm it (another mentor: 403 from the
// route itself); a confirmation that corrects the value writes one MENTOR
// history row and the mentee sees the confirmed level.
test('a mentor confirms an active mentee\'s skill level; another mentor gets 403', async ({ playwright, baseURL }) => {
  const PW = 'SkillConfirm123!';
  const seeded = await seedMenteeWithRelation('skconf', PW);
  const otherEmail = uniqueEmail('skconf-other');
  // The canonical rows live in an org's vocabulary; an org-less account has
  // none to mirror onto, so the three people get one of their own.
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Skill Confirm ${stamp}`, slug: `skill-confirm-${stamp}` } });
  await seedUser(otherEmail, PW, 'MENTOR', 'Other Mentor', org.id);
  await prisma.user.updateMany({ where: { id: { in: [seeded.mentorId, seeded.menteeId] } }, data: { orgId: org.id } });
  await prisma.mentorshipRelation.update({ where: { id: seeded.relationId }, data: { orgId: org.id } });
  const mentee = await playwright.request.newContext({ baseURL });
  const mentor = await playwright.request.newContext({ baseURL });
  const other = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(mentee, seeded.menteeEmail, PW)).ok).toBe(true);
    expect((await signInViaApi(mentor, seeded.mentorEmail, PW)).ok).toBe(true);
    expect((await signInViaApi(other, otherEmail, PW)).ok).toBe(true);

    const save = (levels: Record<string, number>) =>
      mentee.put('/api/profile', { data: { skills: ['React'], skillLevels: levels } });
    const first = await save({ React: 3 });
    expect(first.ok(), await first.text()).toBe(true);
    const row = await prisma.userSkill.findFirst({
      where: { userId: seeded.menteeId, skill: { key: 'react' } },
      select: { id: true, skillId: true, level: true, levelSource: true },
    });
    expect(row).toMatchObject({ level: 3, levelSource: 'SELF' });
    // The same value again appends no history.
    expect((await save({ React: 3 })).ok()).toBe(true);
    expect(await prisma.userSkillLevelChange.count({ where: { userSkillId: row!.id } })).toBe(1);

    const confirmUrl = `/api/mentorship/${seeded.relationId}/skills/${row!.skillId}/confirm`;
    expect((await other.post(confirmUrl, { data: { level: 4 } })).status()).toBe(403);
    expect((await other.get(`/api/mentorship/${seeded.relationId}/skills`)).status()).toBe(403);

    const listed = await (await mentor.get(`/api/mentorship/${seeded.relationId}/skills?locale=en`)).json();
    expect(listed.canConfirm).toBe(true);
    expect(listed.skills).toEqual([expect.objectContaining({ skillId: row!.skillId, level: 3, verified: false })]);

    const confirmed = await mentor.post(confirmUrl, { data: { level: 4 } });
    expect(confirmed.status()).toBe(200);
    expect(await confirmed.json()).toMatchObject({ ok: true, changed: true });
    const after = await prisma.userSkill.findUnique({ where: { id: row!.id } });
    expect(after).toMatchObject({ level: 4, levelSource: 'MENTOR', verifiedById: seeded.mentorId });
    const history = await prisma.userSkillLevelChange.findMany({ where: { userSkillId: row!.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => [h.fromLevel, h.toLevel, h.source])).toEqual([[null, 3, 'SELF'], [3, 4, 'MENTOR']]);

    const me = await (await mentee.get('/api/profile')).json();
    expect(me.verifiedLevels).toEqual({ React: 4 });

    // An ended pair can no longer confirm.
    await prisma.mentorshipRelation.update({ where: { id: seeded.relationId }, data: { status: 'COMPLETED' } });
    expect((await mentor.post(confirmUrl, { data: { level: 5 } })).status()).toBe(403);
  } finally {
    await Promise.all([mentee.dispose(), mentor.dispose(), other.dispose()]);
    await cleanupMenteeWithRelation(seeded);
    await cleanupByEmail(otherEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
