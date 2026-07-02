import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string, home: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('mentee asks a question and the mentor answers it', async ({ page }) => {
  const mentorEmail = uniqueEmail('qa-mentor');
  const menteeEmail = uniqueEmail('qa-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'QA Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'QA Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  let qId = '';

  try {
    await signIn(page, menteeEmail, 'MenteePass123', '/portal');
    const asked = await page.request.post('/api/questions', { data: { relationId: rel.id, question: 'How do I prep for the interview?' } });
    expect(asked.status()).toBe(201);
    qId = (await asked.json()).question.id;

    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    const answered = await page.request.patch(`/api/questions/${qId}`, { data: { answer: 'Practice system design.' } });
    expect(answered.ok()).toBeTruthy();
    expect((await answered.json()).question.answer).toContain('system design');

    const list = await (await page.request.get(`/api/questions?relationId=${rel.id}`)).json();
    expect(list.questions[0].answeredAt).toBeTruthy();
  } finally {
    await prisma.mentorQuestion.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
