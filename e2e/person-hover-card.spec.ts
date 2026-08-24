import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1166: names were plain text nearly everywhere — you could read who someone
// was but not reach them. A card on the name answers "who is this and what can
// I do about them?" without leaving the page, which matters most where the name
// sits inside a form and navigating away would discard half-typed work.
test('a person card opens from a name and offers a way to reach them', async ({ page }) => {
  const mentorEmail = uniqueEmail('card-mentor');
  const menteeEmail = uniqueEmail('card-mentee');
  const pw = 'CardMentor123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Card Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Card Mentee');
  await prisma.user.update({
    where: { id: mentee.id },
    data: { preferredLanguage: 'de', university: 'Card University' },
  });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await signInAsFreshUser(page, mentorEmail, pw, '/mentor');
    await gotoSettled(page, '/mentor/email');
    // The recipient list is client-fetched; wait for it before locating anything.
    await expect(page.getByText('Card Mentee')).toBeVisible({ timeout: 20_000 });

    const trigger = page.getByTestId(`person-trigger-${mentee.id}`);
    await expect(trigger).toBeVisible({ timeout: 15_000 });

    // The recipient checkbox is the neighbouring control; opening the card must
    // not tick it.
    const checkbox = page.getByRole('checkbox').nth(1);
    await expect(checkbox).not.toBeChecked();

    await trigger.click();
    const card = page.getByTestId('person-card');
    await expect(card).toBeVisible();
    await expect(card.getByText('Card Mentee')).toBeVisible();
    await expect(card.getByText('Card University')).toBeVisible();
    // The language they read travels with the card (#1164).
    await expect(card.getByTestId('language-badge-de')).toBeVisible();
    // Their own mentor may email them, so the action is offered.
    await expect(card.getByTestId('person-card-email')).toBeVisible();
    // A mentor's own mentee has a profile page; the card links to it. That
    // route is keyed by the relation, not by the person — a link built from the
    // user id lands on "relation not found".
    await expect(card.getByTestId('person-card-profile')).toHaveAttribute(
      'href',
      `/mentor/mentees/${relation.id}`
    );

    // Selection is untouched by all of that.
    await expect(checkbox).not.toBeChecked();

    // It is anchored to the name it belongs to. Measuring the rect at event
    // time used to read a layout that had not settled (these lists are
    // client-fetched and reflow as they fill) and parked the card in a corner
    // of the screen, pointing at nothing.
    const triggerBox = (await trigger.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(cardBox.y).toBeGreaterThanOrEqual(triggerBox.y);
    expect(cardBox.y - (triggerBox.y + triggerBox.height)).toBeLessThan(24);
    expect(Math.abs(cardBox.x - triggerBox.x)).toBeLessThan(40);

    // Escape closes it.
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

// The card is a lookup by user id, so its authorization is the whole story: it
// must not become a directory of everyone in the database.
test('the card endpoint only answers for people you already share something with', async ({ page }) => {
  const mentorEmail = uniqueEmail('cardauthz-mentor');
  const ownEmail = uniqueEmail('cardauthz-own');
  const strangerEmail = uniqueEmail('cardauthz-stranger');
  const pw = 'CardAuthz123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Card Authz Mentor');
  const own = await seedUser(ownEmail, 'x', 'MENTEE', 'Card Authz Own');
  const stranger = await seedUser(strangerEmail, 'x', 'MENTEE', 'Card Authz Stranger');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: own.id, status: 'ACTIVE' },
  });

  try {
    await signInAsFreshUser(page, mentorEmail, pw, '/mentor');

    const mine = await page.request.get(`/api/people/${own.id}/card`);
    expect(mine.status()).toBe(200);
    expect((await mine.json()).person.fullName).toBe('Card Authz Own');

    // Someone they share nothing with: 404, not 403 — distinguishing the two
    // would make this an account-existence oracle.
    const other = await page.request.get(`/api/people/${stranger.id}/card`);
    expect(other.status()).toBe(404);

    // And an id that does not exist answers identically.
    const missing = await page.request.get('/api/people/does-not-exist/card');
    expect(missing.status()).toBe(404);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(ownEmail);
    await cleanupByEmail(strangerEmail);
  }
});

// The join-request queue is where a name most needs to answer "who is this?":
// the applicant is a stranger to the project until the owner decides on them,
// so neither a membership nor a mentorship exists yet to carry the lookup
// permission. The pending request itself is what grants it.
test('a project owner can open the card of someone asking to join', async ({ page }) => {
  const ownerEmail = uniqueEmail('joincard-owner');
  const applicantEmail = uniqueEmail('joincard-applicant');
  const pw = 'JoinCard123';
  const owner = await seedUser(ownerEmail, pw, 'MENTOR', 'Join Card Owner');
  const applicant = await seedUser(applicantEmail, 'x', 'MENTEE', 'Join Card Applicant');
  await prisma.user.update({
    where: { id: applicant.id },
    data: { university: 'Join Card University' },
  });

  const project = await prisma.project.create({
    data: {
      name: `Join Card Project ${Date.now()}`,
      ownerType: 'MENTOR',
      ownerUserId: owner.id,
      isPublic: true,
      members: { create: [{ userId: owner.id, role: 'OWNER' }] },
      joinRequests: { create: [{ userId: applicant.id, functionalRole: 'TESTER' }] },
    },
  });

  try {
    await signInAsFreshUser(page, ownerEmail, pw, '/mentor');
    await gotoSettled(page, `/projects/${project.id}`);

    const trigger = page.getByTestId(`person-trigger-${applicant.id}`);
    await expect(trigger).toBeVisible({ timeout: 20_000 });

    // Retried: this page compiles on first visit under the dev server, and a
    // Fast Refresh remount right after the click drops the card's open state.
    const card = page.getByTestId('person-card');
    await expect(async () => {
      await trigger.click();
      await expect(card).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(card.getByText('Join Card Applicant')).toBeVisible();
    await expect(card.getByText('Join Card University')).toBeVisible();
    // They are nobody's mentee yet, so there is no profile page to send the
    // owner to — the card still offers a way to talk to them.
    await expect(card.getByTestId('person-card-message')).toBeVisible();
  } finally {
    await prisma.projectJoinRequest.deleteMany({ where: { projectId: project.id } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.conversation.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await cleanupByEmail(ownerEmail);
    await cleanupByEmail(applicantEmail);
  }
});

test('the card endpoint requires a session', async ({ page }) => {
  const res = await page.request.get('/api/people/whoever/card');
  expect(res.status()).toBe(401);
});
