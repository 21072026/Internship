import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser, gotoSettled } from './helpers/auth';

/**
 * A mentee member's view of their own project (#51).
 *
 * The regression this locks down: the project card and detail page counted and
 * named "interns" from legacy MentorshipRelation rows only, so people added
 * through the member panel were invisible — and a mentee member got the public
 * visitor's view of a project they actually work on.
 */

const password = 'TeamPass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentee member sees the roster on their project and their goals on their profile', { tag: '@smoke' }, async ({ page }) => {
  // Two sign-ins plus five navigations: ~50s on an idle machine, over the 60s
  // default when the suite is loaded. Nothing here is waiting on a timeout.
  test.slow();
  const mentorEmail = uniqueEmail('team-mentor');
  const menteeEmail = uniqueEmail('team-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Team Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Team Mentee');

  // A private project whose only membership signal is the members table — the
  // shape that used to render an empty roster and "0 interns".
  const project = await prisma.project.create({
    data: {
      name: `Team Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      isPublic: false,
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE', functionalRole: 'TESTER' },
        ],
      },
    },
  });

  try {
    // The owner sees the merged roster with the functional role on the card.
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    await gotoSettled(page, '/mentor/projects');
    const card = page.locator('[data-testid="project-card"]').filter({ hasText: project.name });
    await expect(card.locator('[data-testid="project-members"]')).toContainText('Team Mentee');
    await expect(card.locator('[data-testid="project-members"]')).toContainText('Tester');

    // The owner hands the mentee a goal.
    const created = await page.request.post(`/api/projects/${project.id}/tasks`, {
      data: { title: 'Read the project and understand it', assigneeId: mentee.id },
    });
    expect(created.ok()).toBeTruthy();

    // The mentee opens the project: roster visible (private project, member
    // access). A goal that belongs to a person is NOT listed here — it moved to
    // that person's profile, so the whole team no longer reads it.
    await signInAsFreshUser(page, menteeEmail, password, '/portal');
    await gotoSettled(page, `/projects/${project.id}`);
    await expect(page.locator('[data-testid="project-team"]')).toContainText('Team Mentor');
    await expect(page.locator('[data-testid="project-team"]')).toContainText('Team Mentee');
    await expect(page.locator('[data-testid="project-goals"]')).not.toContainText(
      'Read the project and understand it'
    );
    // Shortcuts to the owner and the group chat are right there.
    await expect(page.locator('[data-testid="open-group-chat"]')).toBeVisible();
    await expect(page.locator('[data-testid="message-owner"]')).toBeVisible();

    // Their own profile is where the goal lives, and where they tick it off.
    const task = await prisma.projectTask.findFirst({ where: { projectId: project.id } });
    await gotoSettled(page, '/portal/profile');
    const goalRow = page.locator(`[data-testid="project-goal-${task!.id}"]`);
    await expect(goalRow).toContainText('Read the project and understand it');
    await goalRow.locator('button').first().click();
    await expect
      .poll(async () => (await prisma.projectTask.findUnique({ where: { id: task!.id } }))?.done, { timeout: 10_000 })
      .toBe(true);

    await gotoSettled(page, `/projects/${project.id}`);

    // The group chat says who is in the room, with each person's project role.
    await page.locator('[data-testid="open-group-chat"]').click();
    await page.waitForURL(/\/messages\/c\//, { timeout: 20_000 });
    await expect(page.locator('[data-testid="group-participants"]')).toContainText('2');
    await page.locator('[data-testid="group-participants-toggle"]').click();
    await expect(page.locator('[data-testid="group-participants"]')).toContainText('Team Mentor');
    await expect(page.locator('[data-testid="group-participants"]')).toContainText('Tester');
  } finally {
    await prisma.projectTask.deleteMany({ where: { projectId: project.id } });
    await prisma.projectTaskTemplate.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('a mentee can ask to join a public project and the owner approves it', async ({ page }) => {
  const mentorEmail = uniqueEmail('join-mentor');
  const menteeEmail = uniqueEmail('join-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Join Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Join Mentee');

  const project = await prisma.project.create({
    data: {
      name: `Open Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      isPublic: true,
      members: { create: [{ userId: mentor.id, role: 'OWNER' }] },
    },
  });

  try {
    await signInAndSettle(page, menteeEmail, password, '/portal');
    await gotoSettled(page, `/projects/${project.id}`);
    await page.locator('[data-testid="request-to-join"]').click();
    await page.locator('[data-testid="join-role"]').selectOption('TESTER');
    await page.locator('[data-testid="submit-join-request"]').click();
    await expect(page.locator('[data-testid="join-pending"]')).toBeVisible();

    const request = await prisma.projectJoinRequest.findFirst({ where: { projectId: project.id } });
    expect(request?.status).toBe('PENDING');
    expect(request?.functionalRole).toBe('TESTER');

    // The owner approves, which is also what creates the membership.
    await signInAsFreshUser(page, mentorEmail, password, '/mentor');
    await gotoSettled(page, `/projects/${project.id}`);
    await page.locator(`[data-testid="approve-${request!.id}"]`).click();
    await expect
      .poll(
        async () =>
          (await prisma.projectMember.findUnique({
            where: { projectId_userId: { projectId: project.id, userId: mentee.id } },
          }))?.functionalRole,
        { timeout: 10_000 }
      )
      .toBe('TESTER');
  } finally {
    await prisma.projectJoinRequest.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('setting up a series announces only the next meeting, not every occurrence', async ({ page }) => {
  const mentorEmail = uniqueEmail('blast-mentor');
  const menteeEmail = uniqueEmail('blast-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Blast Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Blast Mentee');

  const project = await prisma.project.create({
    data: {
      name: `Blast Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE', functionalRole: 'DEVELOPER' },
        ],
      },
    },
  });
  // A relation bound to the project is what makes the generator produce Meeting
  // rows (and, before this fix, one invitation email per row).
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, projectId: project.id },
  });

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const res = await page.request.post('/api/meeting-series', {
      data: {
        projectId: project.id,
        title: 'Weekly sync',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6], // every day, to get many occurrences fast
        timeOfDay: '09:00',
        weeksAhead: 4,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();

    // Weeks of meetings are created …
    expect(body.createdMeetings).toBeGreaterThan(5);
    // … and exactly one invitation goes out: the next one. The rest are covered
    // by the day-before / hour-before reminders.
    expect(body.invitesSent).toBe(1);
  } finally {
    await prisma.meetingSeriesReminder.deleteMany({ where: { series: { projectId: project.id } } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.meetingSeries.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('the weekly meeting an owner sets is what a member reads', async ({ page }) => {
  const mentorEmail = uniqueEmail('meet-mentor');
  const menteeEmail = uniqueEmail('meet-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Meet Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Meet Mentee');

  const project = await prisma.project.create({
    data: {
      name: `Meeting Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: mentor.id,
      isPublic: false,
      members: {
        create: [
          { userId: mentor.id, role: 'OWNER' },
          { userId: mentee.id, role: 'MENTEE', functionalRole: 'DEVELOPER' },
        ],
      },
    },
  });

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    await gotoSettled(page, `/projects/${project.id}`);
    await page.locator('[data-testid="add-weekly-meeting"]').click();
    await page.getByRole('button', { name: 'Thu', exact: true }).click();
    await page.locator('input[type="time"]').fill('18:30');
    await page.locator('[data-testid="save-weekly-meeting"]').click();

    await expect
      .poll(async () => prisma.meetingSeries.count({ where: { projectId: project.id, active: true } }), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // A mentee member reads the schedule; the link is generated when none is given.
    const series = await prisma.meetingSeries.findFirst({ where: { projectId: project.id } });
    expect(series?.timeOfDay).toBe('18:30');
    expect(series?.fixedLink).toBeTruthy();

    await signInAsFreshUser(page, menteeEmail, password, '/portal');
    await gotoSettled(page, `/projects/${project.id}`);
    await expect(page.locator('[data-testid="weekly-meeting"]')).toContainText('18:30');
  } finally {
    await prisma.meetingSeriesReminder.deleteMany({ where: { series: { projectId: project.id } } });
    await prisma.meeting.deleteMany({ where: { series: { projectId: project.id } } });
    await prisma.meetingSeries.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
