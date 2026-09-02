import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('mentor email lands in the thread and notifies the mentee', async ({ page }) => {
  const mentorEmail = uniqueEmail('msg-mentor');
  const menteeEmail = uniqueEmail('msg-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Msg Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Msg Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/mentor/email', {
      data: { relationIds: [rel.id], subject: 'Welcome', body: 'Glad to mentor you.' },
    });
    expect(res.ok()).toBeTruthy();

    await expect.poll(async () =>
      prisma.message.count({ where: { relationId: rel.id, channel: 'EMAIL' } })
    ).toBeGreaterThan(0);
    await expect.poll(async () =>
      prisma.notification.count({ where: { userId: mentee.id, type: 'message.new' } })
    ).toBeGreaterThan(0);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('mentee can reply in the thread and the mentor is notified', async ({ page }) => {
  const mentorEmail = uniqueEmail('rep-mentor');
  const menteeEmail = uniqueEmail('rep-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Rep Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Rep Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.message.create({ data: { relationId: rel.id, senderId: mentor.id, channel: 'EMAIL', body: 'How is it going?' } });

  try {
    await signIn(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto(`/messages/${rel.id}`);
    await expect(page.getByText('How is it going?')).toBeVisible({ timeout: 10_000 });

    await page.locator('textarea').fill('Going great, thanks!');
    const done = page.waitForResponse((r) => r.url().includes('/api/messages') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send' }).click();
    await done;

    await expect.poll(async () =>
      prisma.message.count({ where: { relationId: rel.id, senderId: mentee.id } })
    ).toBeGreaterThan(0);
    await expect.poll(async () =>
      prisma.notification.count({ where: { userId: mentor.id, type: 'message.new' } })
    ).toBeGreaterThan(0);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

// #1130 — the mentee page used to be a dead end: you could read everything about
// a mentee there and still have no way to write to them. Covers the new entry
// point and the suggested opener an empty thread offers.
test('mentor opens the thread from the mentee page and uses a suggested opener', async ({ page }) => {
  const mentorEmail = uniqueEmail('sug-mentor');
  const menteeEmail = uniqueEmail('sug-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Sug Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Yagmur Kuzu');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto(`/mentor/mentees/${rel.id}`);
    await page.getByTestId('mentee-message-link').click();
    // The mentee card links to the relation URL, which hands over to the pair's
    // single conversation (#1156).
    await page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });

    // Empty thread → openers, and the mentor side gets the welcome one first.
    const suggestions = page.getByTestId('message-suggestions');
    await expect(suggestions).toBeVisible({ timeout: 10_000 });
    await suggestions.getByRole('button').first().click();

    const box = page.getByTestId('message-input');
    await expect(box).toHaveValue(/welcome aboard/i);
    // The mentee's first name is filled in, so the text is ready to send as is.
    await expect(box).toHaveValue(/Yagmur/);

    const done = page.waitForResponse((r) => r.url().includes('/api/messages') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send' }).click();
    await done;

    await expect.poll(async () =>
      prisma.message.count({ where: { relationId: rel.id, senderId: mentor.id } })
    ).toBeGreaterThan(0);
    // Once the thread has history the openers step aside.
    await expect(suggestions).toHaveCount(0);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

// #1871 — a half-written reply used to die with the tab. The draft lives in
// localStorage keyed per thread, so this is the only honest way to test it:
// type, reload the page, look at the box again. Deliberately not @smoke — the
// PR gate stays small.
test('an unsent reply survives a reload and is gone once it is sent', async ({ page }) => {
  const mentorEmail = uniqueEmail('draft-mentor');
  const menteeEmail = uniqueEmail('draft-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Draft Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Draft Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  // Seeded history keeps the empty-thread openers out of the composer.
  await prisma.message.create({ data: { relationId: rel.id, senderId: mentor.id, channel: 'EMAIL', body: 'Any questions?' } });
  const draft = 'Half a thought I will finish later';

  try {
    await signIn(page, menteeEmail, 'MenteePass123', '/portal');
    await page.goto(`/messages/${rel.id}`);
    await expect(page.getByText('Any questions?')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('message-input').fill(draft);
    await page.reload();
    // Restored on mount from localStorage — with no message row written.
    await expect(page.getByTestId('message-input')).toHaveValue(draft, { timeout: 10_000 });
    expect(await prisma.message.count({ where: { relationId: rel.id, senderId: mentee.id } })).toBe(0);

    const sent = page.waitForResponse((r) => r.url().includes('/api/messages') && r.request().method() === 'POST');
    await page.getByTestId('message-send').click();
    await sent;
    await expect(page.getByTestId('message-input')).toHaveValue('');

    // Sending clears the stored draft too, so a reload comes back to an empty
    // box rather than re-offering text that is already in the thread.
    await page.reload();
    await expect(page.getByText(draft).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('message-input')).toHaveValue('');
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
