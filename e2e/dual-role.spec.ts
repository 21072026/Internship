import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #1141 — someone who mentors can also be mentored. The role stays MENTOR; the
// mentee side is derived from an actual mentorship where they are the mentee.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const switcher = 'mode-switcher';

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

test('a mentor who is also mentored can switch to the mentee portal', { tag: '@smoke' }, async ({ page }) => {
  // Three people: the dual-role mentor, the mentor above them, and the mentee
  // below them — so both sides of the dual role are real relations.
  const dualEmail = uniqueEmail('dual-mentor');
  const seniorEmail = uniqueEmail('dual-senior');
  const menteeEmail = uniqueEmail('dual-mentee');

  const dual = await seedUser(dualEmail, 'DualPass123', 'MENTOR', 'Dual Role Mentor');
  const senior = await seedUser(seniorEmail, 'SeniorPass123', 'MENTOR', 'Senior Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Junior Mentee');

  try {
    await prisma.mentorshipRelation.createMany({
      data: [
        // They mentor someone …
        { mentorId: dual.id, menteeId: mentee.id },
        // … and someone mentors them.
        { mentorId: senior.id, menteeId: dual.id },
      ],
    });

    await signIn(page, dualEmail, 'DualPass123');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // The switch appears for them where a plain mentor gets none.
    const box = page.getByTestId(switcher);
    await expect(box).toBeVisible();
    await expect(box.getByText('Mentor', { exact: true })).toHaveAttribute('aria-current', 'page');

    // Into the portal: it is their own mentorship, with their own mentor on it.
    await box.getByRole('link', { name: 'Mentee', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/portal', { timeout: 20_000 });
    await expect(page.getByText('Senior Mentor').first()).toBeVisible();
    await expect(box.getByText('Mentee', { exact: true })).toHaveAttribute('aria-current', 'page');

    // And back out to the mentor shell, where their own mentee is waiting.
    await box.getByRole('link', { name: 'Mentor', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/mentor', { timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'My Mentees', exact: true })).toBeVisible();
  } finally {
    await cleanupByEmail(dualEmail);
    await cleanupByEmail(seniorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('a mentor with no mentorship of their own is still bounced out of the portal', async ({ page }) => {
  const mentorEmail = uniqueEmail('solo-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Solo Mentor');

  try {
    await signIn(page, mentorEmail, 'MentorPass123');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto('/portal');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
    await expect(page.getByTestId(switcher)).toHaveCount(0);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});

test('a mentee given someone to mentor reaches the mentor shell', async ({ page }) => {
  const dualEmail = uniqueEmail('dual-mentee');
  const juniorEmail = uniqueEmail('dual-junior');

  const dual = await seedUser(dualEmail, 'DualPass123', 'MENTEE', 'Peer Mentor');
  const junior = await seedUser(juniorEmail, 'JuniorPass123', 'MENTEE', 'Newer Mentee');

  try {
    await prisma.mentorshipRelation.create({ data: { mentorId: dual.id, menteeId: junior.id } });

    await signIn(page, dualEmail, 'DualPass123');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const box = page.getByTestId(switcher);
    await expect(box).toBeVisible();
    await box.getByRole('link', { name: 'Mentor', exact: true }).click();
    await page.waitForURL((u) => u.pathname === '/mentor', { timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'My Mentees', exact: true })).toBeVisible();
  } finally {
    await cleanupByEmail(dualEmail);
    await cleanupByEmail(juniorEmail);
  }
});

test('a mentee with nobody to mentor is kept out of the mentor shell', async ({ page }) => {
  const menteeEmail = uniqueEmail('plain-mentee');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Plain Mentee');

  try {
    await signIn(page, menteeEmail, 'MenteePass123');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await expect(page.getByTestId(switcher)).toHaveCount(0);
    await page.goto('/mentor');
    await page.waitForURL((u) => !u.pathname.startsWith('/mentor'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
