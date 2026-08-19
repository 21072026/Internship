import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/auth'), { timeout: 20_000 });
}

test('a public profile shows safe fields but not PII; a private one 404s', async ({ page }) => {
  const pubEmail = uniqueEmail('pubprofile');
  const privEmail = uniqueEmail('privprofile');
  const pub = await seedUser(pubEmail, 'Pass123!', 'MENTEE', 'Public Person');
  const priv = await seedUser(privEmail, 'Pass123!', 'MENTEE', 'Private Person');
  await prisma.user.update({
    where: { id: pub.id },
    data: { publicProfile: true, university: 'TH Köln', phone: '+49 111 222', skills: ['React', 'Python'] },
  });

  try {
    // Public profile is visible without auth and shows safe fields only.
    await page.goto(`/p/${pub.id}`);
    await expect(page.getByRole('heading', { name: 'Public Person' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('TH Köln')).toBeVisible();
    await expect(page.getByText('React')).toBeVisible();
    // PII must NOT be exposed.
    await expect(page.getByText(pubEmail)).toHaveCount(0);
    await expect(page.getByText('+49 111 222')).toHaveCount(0);

    // A non-public profile is not found.
    const resp = await page.goto(`/p/${priv.id}`);
    expect(resp?.status()).toBe(404);
  } finally {
    await cleanupByEmail(pubEmail);
    await cleanupByEmail(privEmail);
  }
});

test('a mentor public profile shows mentor fields without PII or mentee identities', async ({ page }) => {
  const mentorEmail = uniqueEmail('public-mentor');
  const privateEmail = uniqueEmail('private-mentor');
  const menteeEmail = uniqueEmail('public-mentor-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass123!', 'MENTOR', 'Public Mentor');
  const privateMentor = await seedUser(privateEmail, 'Pass123!', 'MENTOR', 'Private Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass123!', 'MENTEE', 'Secret Linked Mentee');
  const mentorPhone = '+49 177 9876543';
  const mentorWhatsapp = '+49 176 1234567';

  await prisma.user.update({
    where: { id: mentor.id },
    data: {
      publicProfile: true,
      bio: 'Mentor biography marker',
      interests: 'Distributed systems marker',
      skills: ['Architecture marker'],
      languages: ['English marker', 'German marker'],
      mentorCapacity: 4,
      university: 'Hidden Mentor University',
      department: 'Hidden Mentor Department',
      graduationYear: 2018,
      targetPosition: 'Hidden Target Position',
      phone: mentorPhone,
      whatsapp: mentorWhatsapp,
    },
  });
  await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    const response = await page.goto(`/p/${mentor.id}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByText('Mentor biography marker')).toBeVisible();
    await expect(page.getByText('Distributed systems marker')).toBeVisible();
    await expect(page.getByText('Architecture marker')).toBeVisible();
    await expect(page.getByText('English marker')).toBeVisible();
    await expect(page.getByTestId('public-profile-capacity')).toHaveText('4');
    await expect(page.getByTestId('public-profile-active-mentees')).toHaveText('1');

    for (const hidden of [
      'Hidden Mentor University', 'Hidden Mentor Department', '2018', 'Hidden Target Position',
      mentorEmail, mentorPhone, mentorWhatsapp, mentee.fullName, menteeEmail, mentee.id,
    ]) {
      expect(await page.content()).not.toContain(hidden);
    }

    const privateResponse = await page.goto(`/p/${privateMentor.id}`);
    expect(privateResponse?.status()).toBe(404);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(privateEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('mentee dashboard links only to a public mentor profile', async ({ browser }) => {
  const publicMentorEmail = uniqueEmail('dashboard-public-mentor');
  const privateMentorEmail = uniqueEmail('dashboard-private-mentor');
  const publicMenteeEmail = uniqueEmail('dashboard-public-mentee');
  const privateMenteeEmail = uniqueEmail('dashboard-private-mentee');
  const password = 'Pass123!';
  const publicMentor = await seedUser(publicMentorEmail, password, 'MENTOR', 'Dashboard Public Mentor');
  const privateMentor = await seedUser(privateMentorEmail, password, 'MENTOR', 'Dashboard Private Mentor');
  const publicMentee = await seedUser(publicMenteeEmail, password, 'MENTEE', 'Dashboard Public Mentee');
  const privateMentee = await seedUser(privateMenteeEmail, password, 'MENTEE', 'Dashboard Private Mentee');
  await prisma.user.update({ where: { id: publicMentor.id }, data: { publicProfile: true } });
  await prisma.mentorshipRelation.createMany({
    data: [
      { mentorId: publicMentor.id, menteeId: publicMentee.id },
      { mentorId: privateMentor.id, menteeId: privateMentee.id },
    ],
  });

  const publicContext = await browser.newContext();
  const privateContext = await browser.newContext();
  try {
    const publicPage = await publicContext.newPage();
    await signIn(publicPage, publicMenteeEmail, password);
    await publicPage.goto('/portal');
    await expect(publicPage.locator(`a[href="/p/${publicMentor.id}"]`)).toBeVisible();

    const privatePage = await privateContext.newPage();
    await signIn(privatePage, privateMenteeEmail, password);
    await privatePage.goto('/portal');
    await expect(privatePage.locator(`a[href="/p/${privateMentor.id}"]`)).toHaveCount(0);
  } finally {
    await publicContext.close();
    await privateContext.close();
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: { in: [publicMentor.id, privateMentor.id] } } });
    await cleanupByEmail(publicMentorEmail);
    await cleanupByEmail(privateMentorEmail);
    await cleanupByEmail(publicMenteeEmail);
    await cleanupByEmail(privateMenteeEmail);
  }
});

test('public contact form notifies the owner; honeypot drops bots', async ({ page }) => {
  const email = uniqueEmail('pubcontact');
  const user = await seedUser(email, 'Pass123!', 'MENTEE', 'Contact Target');
  await prisma.user.update({ where: { id: user.id }, data: { publicProfile: true } });

  try {
    await page.goto(`/p/${user.id}`);
    // Product link + contact form are present on the public page.
    await expect(page.getByRole('link', { name: /InternshipCRM/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder(/Your name|Adınız|Ihr Name/)).toBeVisible();

    // Genuine submission → notification for the owner.
    const ok = await page.request.post(`/api/public-contact/${user.id}`, {
      data: { name: 'Recruiter', email: 'r@co.com', message: 'We have a role for you.', renderedAt: Date.now() - 5000 },
    });
    expect(ok.ok()).toBeTruthy();

    // Honeypot filled → silently accepted (200) but dropped.
    const bot = await page.request.post(`/api/public-contact/${user.id}`, {
      data: { name: 'Bot', email: 'b@spam.com', message: 'spam', website: 'http://x', renderedAt: Date.now() - 5000 },
    });
    expect(bot.ok()).toBeTruthy();

    await expect(async () => {
      const notes = await prisma.notification.findMany({ where: { userId: user.id, type: 'public_contact' } });
      expect(notes.length).toBe(1);
      expect(notes[0].text).toContain('Recruiter');
    }).toPass({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});

test('the public profile OG image renders for public profiles and stays generic otherwise', async ({ request }) => {
  const pubEmail = uniqueEmail('ogpub');
  const privEmail = uniqueEmail('ogpriv');
  const pub = await seedUser(pubEmail, 'Pass123!', 'MENTEE', 'ÖG Şahin');
  const priv = await seedUser(privEmail, 'Pass123!', 'MENTEE', 'OG Private');
  await prisma.user.update({
    where: { id: pub.id },
    data: {
      publicProfile: true,
      bio: 'A'.repeat(400), // exercises the JS truncation path
      skills: ['React', 'Python', 'SQL'],
      city: 'Köln',
      country: 'Germany',
    },
  });

  try {
    // Public profile → a real PNG card.
    const pubRes = await request.get(`/p/${pub.id}/opengraph-image`);
    expect(pubRes.status()).toBe(200);
    expect(pubRes.headers()['content-type']).toContain('image/png');
    expect((await pubRes.body()).length).toBeGreaterThan(1000);

    // Private and nonexistent profiles → the same generic brand card, so the
    // image endpoint never reveals whether an id exists.
    for (const path of [`/p/${priv.id}/opengraph-image`, '/p/nonexistent-user-id/opengraph-image']) {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('image/png');
    }
  } finally {
    await cleanupByEmail(pubEmail);
    await cleanupByEmail(privEmail);
  }
});
