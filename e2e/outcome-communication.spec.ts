import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, asHost, MARKETING_HOST } from './helpers/auth';
// Static import, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// #830 — negative-outcome communication.
//
// The distinction the whole feature turns on: INTERNSHIP_FOUND_ELSEWHERE_800
// means the student FOUND an internship. It is a success, and it must never be
// worded like the rejection that INTERNSHIP_DROPPED_460 is. The portal is where
// the mentee reads it, so that is where it is asserted.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string, stage: 'INTERNSHIP_DROPPED_460' | 'INTERNSHIP_FOUND_ELSEWHERE_800') {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Outcome Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Outcome Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE', pipelineStatus: stage },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

test('a dropped candidate is told where they stand, with concrete next steps — and no celebration banner', async ({ page }) => {
  test.slow();
  const { mentorEmail, menteeEmail } = await seedPair('outcome-drop', 'INTERNSHIP_DROPPED_460');
  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    const outcome = page.getByTestId('journey-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome).toContainText('Where things stand');
    // Something to do next — the difference between an ending and a dead end.
    await expect(outcome.getByRole('link', { name: /Update your profile/i })).toBeVisible();
    await expect(outcome.getByRole('link', { name: /Write to your mentor/i })).toBeVisible();
    // A rejection must not be crowned with "🎉 Milestone reached!".
    await expect(page.getByText('Milestone reached')).toHaveCount(0);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('finding an internship elsewhere reads as a success, not a rejection', async ({ page }) => {
  test.slow();
  const { mentorEmail, menteeEmail } = await seedPair('outcome-else', 'INTERNSHIP_FOUND_ELSEWHERE_800');
  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    const outcome = page.getByTestId('journey-outcome');
    await expect(outcome).toBeVisible({ timeout: 20_000 });
    await expect(outcome).toContainText('You found an internship');
    await expect(outcome).toContainText('Congratulations');
    // None of the rejection wording leaks into the celebratory case.
    await expect(outcome).not.toContainText('Where things stand');
    await expect(outcome).not.toContainText('did not end in a placement');
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('moving a mentee to an outcome stage hands the mentor a prefilled draft — and sends nothing on its own', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('outcome-draft-mentor');
  const menteeEmail = uniqueEmail('outcome-draft-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Draft Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Draft Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    const res = await page.request.put(`/api/mentorship/${relation.id}`, {
      // Moving into a negative stage requires a drop-off reason (#810).
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'SKILL_MISMATCH' },
    });
    expect(res.ok()).toBeTruthy();

    // The mentor is told to write, and pointed at the composer with the right
    // template — the "preview + human approval" step the feature is built on.
    const notif = await prisma.notification.findFirst({
      where: { userId: mentor.id, type: 'outcome.needsMessage' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif).not.toBeNull();
    expect(notif?.link).toContain(`/mentor/email?relation=${relation.id}`);
    expect(notif?.link).toContain('template=outcomeNoMatch');

    // The mentee hears about it in their own words, not as a tracker row.
    const menteeNotif = await prisma.notification.findFirst({
      where: { userId: mentee.id, type: 'outcome.noMatch' },
    });
    expect(menteeNotif).not.toBeNull();
    const generic = await prisma.notification.count({ where: { userId: mentee.id, type: 'stage.changed' } });
    expect(generic).toBe(0);

    // Auto-send is off by default: nothing was emailed, so no Email interaction
    // was logged on the relation.
    const emails = await prisma.interactionLog.count({ where: { relationId: relation.id, type: 'Email' } });
    expect(emails).toBe(0);

    // Following the link lands on a composer with the recipient ticked and the
    // outcome template already in the body.
    await page.goto(notif!.link!);
    const body = page.locator('textarea').first();
    await expect(body).toHaveValue(/could not find a placement/i, { timeout: 20_000 });
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a candidate who accepted elsewhere is congratulated, not let down gently', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('outcome-reason-mentor');
  const menteeEmail = uniqueEmail('outcome-reason-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Reason Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Reason Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId: mentee.orgId, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    // Same negative stage as the rejection case — only the reason differs, and
    // the reason is what says this was somebody taking a better offer (#810).
    const res = await page.request.put(`/api/mentorship/${relation.id}`, {
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'ACCEPTED_ELSEWHERE' },
    });
    expect(res.ok()).toBeTruthy();

    const notif = await prisma.notification.findFirst({
      where: { userId: mentor.id, type: 'outcome.needsMessage' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif?.link).toContain('template=outcomePlacedElsewhere');
    const menteeNotif = await prisma.notification.findFirst({
      where: { userId: mentee.id, type: 'outcome.placedElsewhere' },
    });
    expect(menteeNotif).not.toBeNull();
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

// Worlds (docs/worlds.md): the outcome templates are placement wording ("could
// not find a placement"). An org without placements — MARKETING — must get none
// of it: no automatic mail even with auto-send switched on, and no draft behind
// the rep's link. SMTP is blank in this environment, so an attempted send still
// leaves a SKIPPED 'outcome' EmailLog row — which is what makes "nothing was
// sent" observable, and the INTERNSHIP control below proves the row appears.

async function seedOutcomeOrg(vertical: 'INTERNSHIP' | 'MARKETING', prefix: string) {
  const stamp = `${Date.now()}-${Math.round(performance.now())}`;
  const org = await prisma.organization.create({
    data: { name: `Outcome ${vertical} ${stamp}`, slug: `${prefix}-${stamp}`, vertical },
  });
  const preset = defaultTemplateForVertical(vertical);
  if (preset) {
    await prisma.pipelineStage.createMany({
      data: templateStagePayload(preset).stages.map((st) => ({ ...st, orgId: org.id })),
    });
  }
  // Auto-send ON for this tenant only — a tenant row, so no other spec sees it.
  await prisma.setting.create({ data: { orgId: org.id, key: 'outcomeAutoSend', value: 'true' } });
  const mentorEmail = uniqueEmail(`${prefix}-rep`);
  const menteeEmail = uniqueEmail(`${prefix}-lead`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Outcome Rep', org.id);
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Outcome Lead', org.id);
  const relation = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      orgId: org.id,
      status: 'ACTIVE',
      pipelineStatus: vertical === 'MARKETING' ? 'LEAD_QUALIFIED' : 'INTERNSHIP_IN_PROGRESS_450',
    },
  });
  const cleanup = async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.emailLog.deleteMany({ where: { to: menteeEmail } });
    await prisma.statusChange.deleteMany({ where: { relationId: relation.id } }).catch(() => {});
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  };
  return { org, mentor, mentee, mentorEmail, menteeEmail, relation, cleanup };
}

test('a MARKETING lead reaching an outcome gets no placement mail, and the rep no placement draft', async ({ page }) => {
  test.slow();
  const seeded = await seedOutcomeOrg('MARKETING', 'outcome-mkt');
  try {
    // A MARKETING account signs in only on its own world's host (#2590), and a
    // rep lands on the sales surface — only the session cookie matters here.
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', seeded.mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/sales'), { timeout: 30_000 });

    const res = await page.request.put(`/api/mentorship/${seeded.relation.id}`, {
      data: { pipelineStatus: 'DEAL_LOST', reasonCode: 'NO_RESPONSE' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    // The rep is still told to write — pointed at the lead's record, with no
    // template behind the link.
    const notif = await prisma.notification.findFirst({
      where: { userId: seeded.mentor.id, type: 'outcome.needsMessage' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif).not.toBeNull();
    expect(notif?.link).toBe(`/sales/leads/${seeded.relation.id}`);
    expect(notif?.link).not.toContain('template=');

    // Auto-send is on for this org, and still nothing was attempted or logged.
    expect(await prisma.emailLog.count({ where: { to: seeded.menteeEmail, category: 'outcome' } })).toBe(0);
    expect(await prisma.interactionLog.count({ where: { relationId: seeded.relation.id, type: 'Email' } })).toBe(0);
  } finally {
    await seeded.cleanup();
  }
});

test('the INTERNSHIP control: with auto-send on, the outcome mail is attempted and logged', async ({ page }) => {
  test.slow();
  const seeded = await seedOutcomeOrg('INTERNSHIP', 'outcome-int');
  try {
    await signInAndSettle(page, seeded.mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.put(`/api/mentorship/${seeded.relation.id}`, {
      data: { pipelineStatus: 'INTERNSHIP_DROPPED_460', reasonCode: 'SKILL_MISMATCH' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const notif = await prisma.notification.findFirst({
      where: { userId: seeded.mentor.id, type: 'outcome.needsMessage' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notif?.link).toContain('template=outcomeNoMatch');
    // SKIPPED ("SMTP not configured") — the attempt is the point, not delivery.
    expect(await prisma.emailLog.count({ where: { to: seeded.menteeEmail, category: 'outcome' } })).toBe(1);
    expect(await prisma.interactionLog.count({ where: { relationId: seeded.relation.id, type: 'Email' } })).toBe(1);
  } finally {
    await seeded.cleanup();
  }
});
