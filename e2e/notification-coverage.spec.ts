import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Story #886: the events mentees care most about used to produce no in-app
// notification at all. Covers #924 (interaction logged, meeting scheduled),
// #925 (goal assigned/completed, evaluation added — two-way), #926 (stage
// change emits identically from every write path) and #1101 (company interest
// reaches the candidate, consent-limited and with the company identity hidden).
const PASSWORD = 'NotifCover123!';

const mentorEmail = uniqueEmail('cover-mentor');
const menteeEmail = uniqueEmail('cover-mentee');
const adminEmail = uniqueEmail('cover-admin');
let mentorId = '';
let menteeId = '';
let relationId = '';

const menteeCount = (type: string) => prisma.notification.count({ where: { userId: menteeId, type } });
const mentorCount = (type: string) => prisma.notification.count({ where: { userId: mentorId, type } });

test.describe.configure({ mode: 'serial' });

async function signIn(page: import('@playwright/test').Page, email: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}


test.beforeAll(async () => {
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Cover Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Cover Mentee');
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Cover Admin');
  mentorId = mentor.id;
  menteeId = mentee.id;
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId, menteeId } });
  relationId = rel.id;
});

test.afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: [mentorId, menteeId] } } });
  await prisma.interactionLog.deleteMany({ where: { relationId } });
  await prisma.meeting.deleteMany({ where: { relationId } });
  await prisma.goal.deleteMany({ where: { relationId } });
  await prisma.evaluation.deleteMany({ where: { relationId } });
  await prisma.statusChange.deleteMany({ where: { relationId } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  await cleanupByEmail(menteeEmail);
  await cleanupByEmail(mentorEmail);
  await cleanupByEmail(adminEmail);
  await prisma.$disconnect();
});

test('mentor actions notify the mentee — no echo, pref opt-out respected (#924/#925)', async ({ page }) => {
  await signIn(page, mentorEmail, '/mentor');

  // Interaction logged → mentee hears it, the mentor does not hear themselves.
  const inter = await page.request.post('/api/interactions', {
    data: { relationId, date: new Date().toISOString(), notes: 'covered ground', type: 'Feedback' },
  });
  expect(inter.status()).toBe(201);
  await expect.poll(() => menteeCount('interaction.logged')).toBe(1);
  expect(await mentorCount('interaction.logged')).toBe(0);

  // Meeting scheduled → one notification, time rendered on the mentee's clock.
  const meet = await page.request.post('/api/meetings', {
    data: { relationIds: [relationId], title: 'Cover Sync', scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
  });
  expect(meet.ok()).toBeTruthy();
  await expect.poll(() => menteeCount('meeting.scheduled')).toBe(1);
  const meetNote = await prisma.notification.findFirstOrThrow({ where: { userId: menteeId, type: 'meeting.scheduled' } });
  const meetParams = meetNote.params as { title?: string; when?: string };
  expect(meetParams.title).toBe('Cover Sync');
  expect(meetParams.when).toBeTruthy();

  // Goal assigned → mentee notified with the title.
  const goal = await page.request.post('/api/goals', { data: { relationId, title: 'Ship the cover letter' } });
  expect(goal.status()).toBe(201);
  await expect.poll(() => menteeCount('goal.assigned')).toBe(1);

  // Evaluation added → mentee notified; scores/comment must NOT travel along.
  const evalRes = await page.request.post('/api/evaluations', {
    data: { relationId, scores: { technical: 5, communication: 4 }, comment: 'secret feedback body' },
  });
  expect(evalRes.status()).toBe(201);
  await expect.poll(() => menteeCount('evaluation.added')).toBe(1);
  const evalNote = await prisma.notification.findFirstOrThrow({ where: { userId: menteeId, type: 'evaluation.added' } });
  expect(JSON.stringify(evalNote.params)).not.toContain('secret feedback body');

  // Category opt-out: with interactions=false the next log stays silent.
  await prisma.user.update({ where: { id: menteeId }, data: { notificationPrefs: { interactions: false } } });
  const inter2 = await page.request.post('/api/interactions', {
    data: { relationId, date: new Date().toISOString(), notes: 'silent one', type: 'Call' },
  });
  expect(inter2.status()).toBe(201);
  // The write is synchronous with the response; a short settle then assert.
  await expect.poll(() => menteeCount('interaction.logged'), { timeout: 5_000 }).toBe(1);
  await prisma.user.update({ where: { id: menteeId }, data: { notificationPrefs: {} } });
});

test('mentee actions notify the mentor — two-way (#925)', async ({ page }) => {
  const seededGoal = await prisma.goal.create({
    data: { relationId, title: 'Finish portfolio', createdByRole: 'MENTOR' },
  });

  await signIn(page, menteeEmail, '/portal');

  // Mentee marks the goal done → the MENTOR is told, not the mentee.
  const done = await page.request.patch(`/api/goals/${seededGoal.id}`, { data: { status: 'DONE' } });
  expect(done.ok()).toBeTruthy();
  await expect.poll(() => mentorCount('goal.completed')).toBe(1);
  expect(await menteeCount('goal.completed')).toBe(0);
  expect((await prisma.notification.findFirstOrThrow({ where: { userId: mentorId, type: 'goal.completed' } })).link).toBe(`/mentor/mentees/${relationId}`);

  // Re-saving the already-done goal must not notify again.
  const again = await page.request.patch(`/api/goals/${seededGoal.id}`, { data: { status: 'DONE', title: 'Finish portfolio v2' } });
  expect(again.ok()).toBeTruthy();
  await expect.poll(() => mentorCount('goal.completed'), { timeout: 5_000 }).toBe(1);

  // Mentee evaluates the mentor → the mentor is told.
  const evalRes = await page.request.post('/api/evaluations', { data: { relationId, scores: { guidance: 5 } } });
  expect(evalRes.status()).toBe(201);
  await expect.poll(() => mentorCount('evaluation.added')).toBe(1);
  expect((await prisma.notification.findFirstOrThrow({ where: { userId: mentorId, type: 'evaluation.added' } })).link).toBe(`/mentor/mentees/${relationId}`);
});

test('every stage-write path emits the same notification + keeps pipelineStatus in sync (#926)', async ({ page }) => {
  await signIn(page, adminEmail, '/admin');

  // Path 1: the manual status-changes endpoint, non-backdated → real move.
  const move1 = await page.request.post('/api/status-changes', {
    data: { relationId, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220' },
  });
  expect(move1.status()).toBe(201);
  await expect.poll(() => menteeCount('stage.changed')).toBe(1);
  const relAfter1 = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(relAfter1.pipelineStatus).toBe('APPROVAL_PENDING_220');

  // Backdated entry = history correction: no stage move, no notification.
  const backdated = await page.request.post('/api/status-changes', {
    data: { relationId, fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() },
  });
  expect(backdated.status()).toBe(201);
  const relAfter2 = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(relAfter2.pipelineStatus).toBe('APPROVAL_PENDING_220');
  await expect.poll(() => menteeCount('stage.changed'), { timeout: 5_000 }).toBe(1);

  // No-op "change" to the current stage: history row ok, no notification (#894).
  const noop = await page.request.post('/api/status-changes', {
    data: { relationId, fromStatus: 'APPROVAL_PENDING_220', toStatus: 'APPROVAL_PENDING_220' },
  });
  expect(noop.status()).toBe(201);
  await expect.poll(() => menteeCount('stage.changed'), { timeout: 5_000 }).toBe(1);

  // Path 2: bulk advance → exactly one more notification for the person.
  const bulk = await page.request.post('/api/admin/candidates/bulk', {
    data: { candidateIds: [menteeId], action: 'advanceStage' },
  });
  expect(bulk.ok()).toBeTruthy();
  await expect.poll(() => menteeCount('stage.changed')).toBe(2);
  const relAfter3 = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(relAfter3.pipelineStatus).toBe('INTERVIEW_PENDING_250');
});

test('company interest reaches the candidate — consent-limited, identity hidden, PASS never relayed (#1101)', async ({ page }) => {
  const companyUserEmail = uniqueEmail('cover-company');
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  const company = await prisma.company.create({ data: { name: 'Covert Corp GmbH', orgId: org.id } });
  const companyUser = await seedUser(companyUserEmail, PASSWORD, 'COMPANY', 'Cover Company User');
  await prisma.user.update({ where: { id: companyUser.id }, data: { companyId: company.id, orgId: org.id } });
  await prisma.mentorshipRelation.update({ where: { id: relationId }, data: { companyId: company.id, orgId: org.id } });

  try {
    await signIn(page, companyUserEmail, '/company');

    // Without TALENT_POOL_VISIBILITY consent, "you were seen" is never sent.
    const res1 = await page.request.post('/api/company/interests', {
      data: { menteeId, status: 'INTERESTED' },
    });
    expect(res1.ok()).toBeTruthy();
    await expect.poll(() => mentorCount('company_interest.interested')).toBe(1);
    expect(await menteeCount('company_interest.mentee')).toBe(0);

    // With consent, the next status CHANGE reaches the mentee — but never the
    // company's name, note, or status jargon.
    await prisma.userConsent.create({ data: { userId: menteeId, type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } });
    const res2 = await page.request.post('/api/company/interests', {
      data: { menteeId, status: 'SHORTLISTED', note: 'internal hiring note' },
    });
    expect(res2.ok()).toBeTruthy();
    await expect.poll(() => menteeCount('company_interest.mentee')).toBe(1);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: menteeId, type: 'company_interest.mentee' } });
    const raw = JSON.stringify(note.params);
    expect(raw).not.toContain('Covert Corp');
    expect(raw).not.toContain('internal hiring note');
    expect(raw).not.toContain('SHORTLISTED');

    // PASS is a status change but must NOT be relayed to the candidate.
    const res3 = await page.request.post('/api/company/interests', {
      data: { menteeId, status: 'PASS' },
    });
    expect(res3.ok()).toBeTruthy();
    await expect.poll(() => mentorCount('company_interest.passed'), { timeout: 5_000 }).toBe(1);
    expect(await menteeCount('company_interest.mentee')).toBe(1);
  } finally {
    await prisma.companyInterest.deleteMany({ where: { menteeId } });
    await prisma.userConsent.deleteMany({ where: { userId: menteeId } });
    await prisma.mentorshipRelation.update({ where: { id: relationId }, data: { companyId: null } }).catch(() => {});
    await cleanupByEmail(companyUserEmail);
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
  }
});
