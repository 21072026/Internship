import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2314: the profile's skills field used to be a single-line <input> split on
// commas. A browser strips the line breaks out of a multi-line paste, so a
// mentee pasting their CV's skill list stored ONE 300-character "skill" — which
// then filled half the admin dashboard's "Yeni Adaylar" card.
//
// The fix is `SkillsField` reading the paste from the CLIPBOARD (where the
// newlines still exist) instead of from the input's value. This spec exercises
// exactly that path, because it is the one place the browser's own behaviour is
// the bug: a unit test cannot lose a line break the way an <input> does.
const PASTED_CV_LIST = [
  'Java C# / .NET',
  'Backend Development',
  'REST API / API Development',
  'SQL / PostgreSQL',
  'Spring Boot',
  'FastAPI Python',
  'Generative AI / AI Tools',
  'Power BI',
  'Microsoft Excel',
  'Git / GitHub',
  'Swagger / API Testing',
  'Entity Framework Core',
  'Data Analysis',
  'Database Management',
].join('\n');

test('a pasted multi-line skill list becomes separate skills, and the blob is refused', async ({ page }) => {
  const email = uniqueEmail('skills-mentee');
  const user = await seedUser(email, 'MenteePass123', 'MENTEE', 'Skills Paste Mentee');

  const field = page.getByTestId('skills-field');
  const input = page.getByTestId('skills-field-input');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal/profile');
    await expect(input).toBeVisible();

    // The real paste: a ClipboardEvent carrying the multi-line text, which is
    // what the DOM hands the component before it flattens the value.
    await input.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, PASTED_CV_LIST);

    await expect(field.getByTestId('skills-field-chip')).toHaveCount(14);
    await expect(page.getByTestId('skills-field-counter')).toContainText('14');
    await expect(page.getByTestId('skills-field-notice')).toContainText('14');
    // The composite labels are one skill each — the slash must not split.
    await expect(field.getByText('SQL / PostgreSQL', { exact: true })).toBeVisible();

    // One entry cannot be typed past the cap: it is refused with a reason and
    // no chip appears, rather than being stored and truncated behind the
    // user's back.
    await input.fill('x'.repeat(80));
    await input.press('Enter');
    await expect(page.getByTestId('skills-field-notice')).toBeVisible();
    await expect(field.getByTestId('skills-field-chip')).toHaveCount(14);

    await input.fill('');
    await page.getByRole('button', { name: /save/i }).first().click();

    await expect
      .poll(async () => {
        const row = await prisma.user.findUnique({ where: { id: user.id }, select: { skills: true } });
        return Array.isArray(row?.skills) ? (row!.skills as string[]).length : 0;
      }, { timeout: 15_000 })
      .toBe(14);

    const saved = await prisma.user.findUnique({ where: { id: user.id }, select: { skills: true } });
    const skills = saved!.skills as string[];
    expect(skills).toContain('Database Management');
    expect(Math.max(...skills.map((s) => s.length))).toBeLessThanOrEqual(60);
  } finally {
    await cleanupByEmail(email);
  }
});
