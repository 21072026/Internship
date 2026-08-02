import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
// This spec hops between three sessions, so every sign-in is a user switch —
// see signInAsFreshUser for why a blanket clearCookies() is not enough (it also
// drops the seeded consent cookie, putting the banner back over the form).
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('messages track read/unread and the sender sees a read receipt', async ({ page }) => {
  const mentorEmail = uniqueEmail('cm-mentor');
  const menteeEmail = uniqueEmail('cm-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'CM Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'CM Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    // Mentor posts a message.
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    const posted = await page.request.post('/api/messages', { data: { relationId: rel.id, body: 'Hello mentee' } });
    expect(posted.status()).toBe(201);

    // Mentee has one unread message until they open the thread.
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');
    let unread = await (await page.request.get('/api/messages/unread')).json();
    expect(unread.count).toBe(1);
    await page.request.get(`/api/messages?relationId=${rel.id}`); // opening marks it read
    unread = await (await page.request.get('/api/messages/unread')).json();
    expect(unread.count).toBe(0);

    // Back as mentor, the message now carries a readAt timestamp.
    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');
    const thread = await (await page.request.get(`/api/messages?relationId=${rel.id}`)).json();
    expect(thread.messages[0].readAt).toBeTruthy();
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('admin broadcasts an announcement to all users and toggles email preference', async ({ page }) => {
  const adminEmail = uniqueEmail('cm-admin');
  const userEmail = uniqueEmail('cm-user');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'CM Admin');
  const user = await seedUser(userEmail, 'UserPass123', 'MENTEE', 'CM User');

  try {
    // A user opts out of email notifications via their profile API.
    await signInAsFreshUser(page, userEmail, 'UserPass123', '/portal');
    const pref = await page.request.put('/api/profile', { data: { emailNotifications: false } });
    expect(pref.ok()).toBeTruthy();
    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.emailNotifications).toBe(false);

    // Admin broadcasts an announcement.
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const sent = await page.request.post('/api/admin/announcements', { data: { text: 'Welcome to the platform!' } });
    expect(sent.status()).toBe(201);
    expect((await sent.json()).recipients).toBeGreaterThan(0);

    // The user received it as an in-app notification.
    await signInAsFreshUser(page, userEmail, 'UserPass123', '/portal');
    const notifs = await (await page.request.get('/api/notifications')).json();
    expect(notifs.items.some((n: { text: string }) => n.text === 'Welcome to the platform!')).toBeTruthy();
  } finally {
    await prisma.notification.deleteMany({ where: { userId: user.id } });
    await cleanupByEmail(userEmail);
    await cleanupByEmail(adminEmail);
  }
});
