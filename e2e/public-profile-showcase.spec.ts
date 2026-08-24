import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Story #1086: the public profile becomes a proof showcase. #1091 — public
// projects + completed-task count (private projects must never leak even a
// name; task titles never shown; the section is user-switchable). #1094 —
// consent-gated mentor evaluation summary (derived average + one approved
// excerpt; without consent not a single evaluation string renders).
const PUBLIC_PROJECT = 'Showcase Public Project';
const PRIVATE_PROJECT = 'Top Secret Internal Project';
const EXCERPT = 'Grew from beginner to shipping features independently';
const SECRET_TASK = 'Secret task title never shown';

const mentorEmail = uniqueEmail('showcase-mentor');
const menteeEmail = uniqueEmail('showcase-mentee');
let mentorId = '';
let menteeId = '';
let relationId = '';
const projectIds: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const mentor = await seedUser(mentorEmail, 'Showcase123!', 'MENTOR', 'Showcase Mentor');
  const mentee = await seedUser(menteeEmail, 'Showcase123!', 'MENTEE', 'Showcase Mentee');
  mentorId = mentor.id;
  menteeId = mentee.id;
  await prisma.user.update({ where: { id: menteeId }, data: { publicProfile: true } });
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId, menteeId } });
  relationId = rel.id;

  const publicProject = await prisma.project.create({
    data: { name: PUBLIC_PROJECT, isPublic: true, status: 'ACTIVE', ownerType: 'MENTOR', ownerUserId: mentorId, technologies: ['React', 'Prisma'] },
  });
  const privateProject = await prisma.project.create({
    data: { name: PRIVATE_PROJECT, isPublic: false, status: 'ACTIVE', ownerType: 'MENTOR', ownerUserId: mentorId },
  });
  projectIds.push(publicProject.id, privateProject.id);
  await prisma.projectMember.createMany({
    data: [
      { projectId: publicProject.id, userId: menteeId, functionalRole: 'DEVELOPER' },
      { projectId: privateProject.id, userId: menteeId, functionalRole: 'DEVELOPER' },
    ],
  });
  await prisma.projectTask.createMany({
    data: [
      { projectId: publicProject.id, title: 'Public task 1', done: true, assigneeId: menteeId },
      { projectId: publicProject.id, title: 'Public task 2', done: true, assigneeId: menteeId },
      { projectId: privateProject.id, title: SECRET_TASK, done: true, assigneeId: menteeId },
    ],
  });
});

test.afterAll(async () => {
  await prisma.projectTask.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.projectMember.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.evaluation.deleteMany({ where: { relationId } });
  await prisma.mentorshipRelation.deleteMany({ where: { id: relationId } });
  await cleanupByEmail(menteeEmail);
  await cleanupByEmail(mentorEmail);
  await prisma.$disconnect();
});

test('public projects show with role and task count; a private project leaks nothing (#1091)', async ({ page }) => {
  await page.goto(`/p/${menteeId}`);
  const section = page.getByTestId('public-projects');
  await expect(section).toBeVisible();
  await expect(section.getByText(PUBLIC_PROJECT)).toBeVisible();
  await expect(section.getByText('Developer')).toBeVisible();
  await expect(section.getByText('React')).toBeVisible();
  // Only the two PUBLIC done tasks count — the private one never contributes.
  await expect(page.getByTestId('public-projects-tasks')).toContainText('2');

  // The private project leaks nothing — not its name, not its task title.
  const html = await page.content();
  expect(html).not.toContain(PRIVATE_PROJECT);
  expect(html).not.toContain(SECRET_TASK);
  expect(html).not.toContain('Public task 1');
});

test('the user can switch the showcase off (#1091)', async ({ page }) => {
  await prisma.user.update({ where: { id: menteeId }, data: { publicShowProjects: false } });
  await page.goto(`/p/${menteeId}`);
  await expect(page.getByTestId('public-projects')).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toContain(PUBLIC_PROJECT);
  await prisma.user.update({ where: { id: menteeId }, data: { publicShowProjects: true } });
});

test('evaluation summary renders only behind every consent/publish gate (#1094)', async ({ page }) => {
  // A published, approved evaluation exists — but no consents yet.
  await prisma.evaluation.create({
    data: {
      relationId,
      authorId: mentorId,
      scores: { technical: 5, communication: 4, reliability: 5, growth: 4 },
      comment: 'full private comment text',
      publicExcerpt: EXCERPT,
      excerptApprovedAt: new Date(),
      sharedPublicly: true,
      publishedAt: new Date(),
    },
  });

  // Without the mentee's consent: not a single evaluation string on the page.
  await page.goto(`/p/${menteeId}`);
  await expect(page.getByTestId('public-evaluation-summary')).toHaveCount(0);
  let html = await page.content();
  expect(html).not.toContain(EXCERPT);

  // Both consents on → the derived average and the approved excerpt appear.
  for (const userId of [menteeId, mentorId]) {
    await prisma.userConsent.upsert({
      where: { userId_type: { userId, type: 'TESTIMONIAL' } },
      create: { userId, type: 'TESTIMONIAL', grantedAt: new Date() },
      update: { grantedAt: new Date(), revokedAt: null },
    });
  }
  await page.goto(`/p/${menteeId}`);
  await expect(page.getByTestId('public-evaluation-summary')).toBeVisible();
  await expect(page.getByTestId('public-evaluation-average')).toContainText('4.5');
  await expect(page.getByText(EXCERPT)).toBeVisible();
  html = await page.content();
  // Raw scores JSON, the original comment and the mentor's full name (initials
  // by default) never reach the public page.
  expect(html).not.toContain('full private comment text');
  expect(html).not.toContain('"technical"');
  expect(html).not.toContain('Showcase Mentor');
  expect(html).toContain('S. M.');

  // The mentor (author) revokes → the section disappears on the next request.
  await prisma.userConsent.update({
    where: { userId_type: { userId: mentorId, type: 'TESTIMONIAL' } },
    data: { revokedAt: new Date() },
  });
  await page.goto(`/p/${menteeId}`);
  await expect(page.getByTestId('public-evaluation-summary')).toHaveCount(0);
});
