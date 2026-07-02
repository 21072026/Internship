import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC F (#419) — a mentee added without an email gets a generated placeholder.
// The name may contain Turkish letters (ı, ş, ğ, ü, ö, ç); the placeholder must
// be transliterated to plain ASCII so it stays a valid, sane-looking email.
test('a Turkish-named mentee without email gets an ASCII placeholder email', async ({ page }) => {
  const mentorEmail = uniqueEmail('translit-mentor');
  const password = 'MentorPass123!';
  await seedUser(mentorEmail, password, 'MENTOR', 'Translit Mentor');
  const menteeName = `Şükrü Çağdaş Öğütürk ${Date.now()}`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto('/mentor/mentees/new');
    await page.getByLabel(/Full Name/).fill(menteeName);
    // Deliberately leave the email empty → placeholder path.
    const created = page.waitForResponse(
      (r) => r.url().includes('/api/mentor/mentees') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create' }).click();
    await created;

    const mentee = await prisma.user.findFirst({ where: { fullName: menteeName, role: 'MENTEE' } });
    expect(mentee).not.toBeNull();
    // Pure ASCII, no Turkish diacritics leaked into the address.
    expect(mentee!.email).toMatch(/^mentee\.[a-z0-9.]+\.[0-9a-f]+@import\.local$/);
    expect(mentee!.email).toContain('sukru.cagdas.oguturk');
    // eslint-disable-next-line no-control-regex
    expect(mentee!.email).toMatch(/^[\x00-\x7F]+$/);

    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee!.id } });
    await prisma.user.delete({ where: { id: mentee!.id } }).catch(() => {});
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});

// EPIC F (#419) — a mentee can only have one ACTIVE mentorship relation at a time.
// Assigning a second mentor while one is active must be rejected with 409.
test('assigning a mentee who already has an active relation returns 409', async ({ page }) => {
  const adminEmail = uniqueEmail('dup-admin');
  const mentorAEmail = uniqueEmail('dup-mentor-a');
  const mentorBEmail = uniqueEmail('dup-mentor-b');
  const menteeEmail = uniqueEmail('dup-mentee');
  const password = 'AdminPass123!';

  await seedUser(adminEmail, password, 'ADMIN', 'Dup Admin');
  const mentorA = await seedUser(mentorAEmail, 'MentorPass123!', 'MENTOR', 'Dup Mentor A');
  const mentorB = await seedUser(mentorBEmail, 'MentorPass123!', 'MENTOR', 'Dup Mentor B');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Dup Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // First assignment succeeds (creates an ACTIVE relation).
    const first = await page.request.post('/api/mentorship', {
      data: { mentorId: mentorA.id, menteeId: mentee.id },
    });
    expect(first.status()).toBe(201);

    // Second assignment for the same mentee is rejected — already active.
    const second = await page.request.post('/api/mentorship', {
      data: { mentorId: mentorB.id, menteeId: mentee.id },
    });
    expect(second.status()).toBe(409);
    const body = await second.json();
    expect(body.error).toMatch(/active mentorship/i);

    // Only one relation was ever persisted for this mentee.
    const relCount = await prisma.mentorshipRelation.count({ where: { menteeId: mentee.id } });
    expect(relCount).toBe(1);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorAEmail);
    await cleanupByEmail(mentorBEmail);
    await cleanupByEmail(adminEmail);
  }
});
