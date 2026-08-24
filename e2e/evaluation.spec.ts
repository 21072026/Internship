import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor can record an evaluation for their mentee', async ({ page }) => {
  const mentorEmail = uniqueEmail('ev-mentor');
  const menteeEmail = uniqueEmail('ev-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Ev Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Ev Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.post('/api/evaluations', {
      data: { relationId: rel.id, scores: { technical: 4, communication: 5 }, comment: 'Strong start.' },
    });
    expect(res.status()).toBe(201);
    const ev = await prisma.evaluation.findFirst({ where: { relationId: rel.id } });
    expect(ev?.authorId).toBe(mentor.id);
    expect((ev?.scores as Record<string, number>).technical).toBe(4);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a mentor can delete an evaluation they recorded by mistake, but not the mentee’s', async ({ page }) => {
  const mentorEmail = uniqueEmail('evdel-mentor');
  const menteeEmail = uniqueEmail('evdel-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'EvDel Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'EvDel Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const mine = await prisma.evaluation.create({
    data: { relationId: rel.id, authorId: mentor.id, scores: { technical: 5 } },
  });
  const theirs = await prisma.evaluation.create({
    data: { relationId: rel.id, authorId: mentee.id, scores: { guidance: 5 } },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // The mentee's evaluation of the mentor is not the mentor's to remove.
    const forbidden = await page.request.delete(`/api/evaluations/${theirs.id}`);
    expect(forbidden.status()).toBe(403);
    expect(await prisma.evaluation.findUnique({ where: { id: theirs.id } })).not.toBeNull();

    const res = await page.request.delete(`/api/evaluations/${mine.id}`);
    expect(res.ok()).toBeTruthy();
    expect(await prisma.evaluation.findUnique({ where: { id: mine.id } })).toBeNull();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('mentor received feedback is private, read-only, and uses only mentor criteria', { tag: '@smoke' }, async ({ browser }) => {
  const adminEmail = uniqueEmail('feedback-admin');
  const mentorAEmail = uniqueEmail('feedback-mentor-a');
  const mentorBEmail = uniqueEmail('feedback-mentor-b');
  const emptyMentorEmail = uniqueEmail('feedback-empty-mentor');
  const menteeOneEmail = uniqueEmail('feedback-mentee-one');
  const menteeTwoEmail = uniqueEmail('feedback-mentee-two');
  const foreignMenteeEmail = uniqueEmail('feedback-foreign-mentee');
  const password = 'FeedbackPass123';
  await seedUser(adminEmail, password, 'ADMIN', 'Feedback Admin');
  const mentorA = await seedUser(mentorAEmail, password, 'MENTOR', 'Feedback Mentor A');
  const mentorB = await seedUser(mentorBEmail, password, 'MENTOR', 'Feedback Mentor B');
  await seedUser(emptyMentorEmail, password, 'MENTOR', 'Empty Feedback Mentor');
  const menteeOne = await seedUser(menteeOneEmail, password, 'MENTEE', 'Feedback Mentee One');
  const menteeTwo = await seedUser(menteeTwoEmail, 'x', 'MENTEE', 'Feedback Mentee Two');
  const foreignMentee = await seedUser(foreignMenteeEmail, 'x', 'MENTEE', 'Foreign Feedback Mentee');
  const relationOne = await prisma.mentorshipRelation.create({ data: { mentorId: mentorA.id, menteeId: menteeOne.id } });
  const relationTwo = await prisma.mentorshipRelation.create({ data: { mentorId: mentorA.id, menteeId: menteeTwo.id } });
  const foreignRelation = await prisma.mentorshipRelation.create({ data: { mentorId: mentorB.id, menteeId: foreignMentee.id } });
  const now = new Date();
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
  await prisma.evaluation.createMany({
    data: [
      { relationId: relationOne.id, authorId: menteeOne.id, type: 'INTERIM', scores: { guidance: 5, availability: 4, expertise: 3, support: 2, technical: 1 }, comment: 'Own feedback one', createdAt: previousMonth },
      { relationId: relationTwo.id, authorId: menteeTwo.id, type: 'FINAL', scores: { guidance: 3, availability: 2, expertise: 5, support: 4 }, comment: 'Own feedback two', createdAt: now },
      { relationId: relationOne.id, authorId: mentorA.id, scores: { technical: 5 }, comment: 'Mentor-authored evaluation' },
      { relationId: foreignRelation.id, authorId: foreignMentee.id, scores: { guidance: 1, availability: 1, expertise: 1, support: 1 }, comment: 'Foreign feedback' },
    ],
  });

  const anonymousContext = await browser.newContext();
  const mentorContext = await browser.newContext();
  const menteeContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const emptyMentorContext = await browser.newContext();
  try {
    expect((await anonymousContext.request.get('/api/evaluations?received=1')).status()).toBe(401);

    const menteePage = await menteeContext.newPage();
    await signInAsFreshUser(menteePage, menteeOneEmail, password, '/portal');
    expect((await menteePage.request.get('/api/evaluations?received=1')).status()).toBe(403);

    const adminPage = await adminContext.newPage();
    await signInAsFreshUser(adminPage, adminEmail, password, '/admin');
    expect((await adminPage.request.get('/api/evaluations?received=1')).status()).toBe(403);

    const mentorPage = await mentorContext.newPage();
    await signInAsFreshUser(mentorPage, mentorAEmail, password, '/mentor');
    const ownRelation = await mentorPage.request.get(`/api/evaluations?relationId=${relationOne.id}`);
    expect(ownRelation.ok()).toBeTruthy();
    expect((await ownRelation.json()).evaluations).toHaveLength(2);
    expect((await mentorPage.request.get(`/api/evaluations?relationId=${foreignRelation.id}`)).status()).toBe(403);
    expect((await mentorPage.request.get(`/api/evaluations?received=1&userId=${mentorB.id}`)).status()).toBe(400);

    const aggregate = await (await mentorPage.request.get('/api/evaluations?received=1')).json();
    expect(aggregate.evaluations).toHaveLength(2);
    expect(aggregate.evaluations.every((evaluation: { direction: string }) => evaluation.direction === 'MENTEE_ON_MENTOR')).toBeTruthy();

    await mentorPage.goto('/mentor/feedback');
    await expect(mentorPage.getByRole('link', { name: 'Feedback' })).toHaveAttribute('href', '/mentor/feedback');
    await expect(mentorPage.getByText('Feedback Mentee One')).toBeVisible();
    await expect(mentorPage.getByText('Feedback Mentee Two')).toBeVisible();
    await expect(mentorPage.getByText('Mentor-authored evaluation')).toHaveCount(0);
    await expect(mentorPage.getByText('Foreign feedback')).toHaveCount(0);
    await expect(mentorPage.getByTestId('mentor-feedback-overall')).toHaveText('3.5/5');
    await expect(mentorPage.locator('p').filter({ hasText: /^Guidance$/ }).locator('..')).toContainText('4.0/5');
    await expect(mentorPage.locator('p').filter({ hasText: /^Availability$/ }).locator('..')).toContainText('3.0/5');
    await expect(mentorPage.locator('p').filter({ hasText: /^Expertise$/ }).locator('..')).toContainText('4.0/5');
    await expect(mentorPage.locator('p').filter({ hasText: /^Support$/ }).locator('..')).toContainText('3.0/5');

    const trendMonths = mentorPage.getByTestId('mentor-feedback-trend').locator(':scope > div');
    await expect(trendMonths).toHaveCount(2);
    await expect(trendMonths.nth(0)).toContainText(new Intl.DateTimeFormat('en', { month: 'short' }).format(previousMonth));
    await expect(trendMonths.nth(0)).toContainText('3.5');
    await expect(trendMonths.nth(1)).toContainText(new Intl.DateTimeFormat('en', { month: 'short' }).format(now));
    await expect(trendMonths.nth(1)).toContainText('3.5');

    const firstFeedback = mentorPage.getByTestId('mentor-feedback-item').filter({ hasText: 'Feedback Mentee One' });
    await expect(firstFeedback).toContainText('Interim');
    await expect(firstFeedback).toContainText('Guidance: 5/5');
    await expect(firstFeedback).toContainText('Availability: 4/5');
    await expect(firstFeedback).toContainText('Expertise: 3/5');
    await expect(firstFeedback).toContainText('Support: 2/5');
    await expect(firstFeedback).toContainText('Own feedback one');
    await expect(firstFeedback).toContainText(new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(previousMonth));

    const secondFeedback = mentorPage.getByTestId('mentor-feedback-item').filter({ hasText: 'Feedback Mentee Two' });
    await expect(secondFeedback).toContainText('Final');
    await expect(secondFeedback).toContainText('Own feedback two');

    const emptyMentorPage = await emptyMentorContext.newPage();
    await signInAsFreshUser(emptyMentorPage, emptyMentorEmail, password, '/mentor');
    await emptyMentorPage.getByRole('link', { name: 'Feedback' }).click();
    await expect(emptyMentorPage).toHaveURL(/\/mentor\/feedback$/);
    await expect(emptyMentorPage.getByTestId('mentor-feedback-empty')).toHaveText('You have not received any feedback yet.');
    await expect(emptyMentorPage.getByTestId('mentor-feedback-overall')).toHaveCount(0);
    await expect(emptyMentorPage.getByText('Overall average')).toHaveCount(0);
    await expect(emptyMentorPage.getByText('Total feedback')).toHaveCount(0);
    await expect(emptyMentorPage.getByTestId('mentor-feedback-trend')).toHaveCount(0);
  } finally {
    await anonymousContext.close();
    await mentorContext.close();
    await menteeContext.close();
    await adminContext.close();
    await emptyMentorContext.close();
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [relationOne.id, relationTwo.id, foreignRelation.id] } } });
    await cleanupByEmail(foreignMenteeEmail);
    await cleanupByEmail(menteeTwoEmail);
    await cleanupByEmail(menteeOneEmail);
    await cleanupByEmail(emptyMentorEmail);
    await cleanupByEmail(mentorBEmail);
    await cleanupByEmail(mentorAEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('a mentee can self-assess their skill levels', async ({ page }) => {
  const email = uniqueEmail('sl-mentee');
  const mentee = await seedUser(email, 'MenteePass123', 'MENTEE', 'SL Mentee');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const res = await page.request.put('/api/profile', {
      data: { skills: ['React', 'Docker'], skillLevels: { React: 4, Docker: 2 } },
    });
    expect(res.ok()).toBeTruthy();
    const u = await prisma.user.findUnique({ where: { id: mentee.id } });
    expect((u?.skillLevels as Record<string, number>).React).toBe(4);
  } finally {
    await cleanupByEmail(email);
  }
});
