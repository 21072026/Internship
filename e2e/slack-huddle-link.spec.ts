import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// #2879 — a Slack huddle link is a bring-your-own meeting link (#2007): pasted
// as the personal room on /account it is accepted like a Zoom room, and when
// the meeting panel cannot frame it the fallback button names the product.
// Untagged on purpose: the rule itself is pinned by slack-huddle.unit.spec.ts
// (@smoke); these are the two screens around it, covered by the scheduled
// suite. Two tests rather than one so each screen has its own time budget:
// against a cold dev server the first visit of /account and /mentor/mentees
// together spent most of a single test's 60s on compilation.

test.afterAll(async () => {
  await prisma.$disconnect();
});

const HUDDLE = 'https://app.slack.com/huddle/T0123ABCD/C0456EFGH';

async function seedHuddleOrg(prefix: string) {
  const slug = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // PREFER_PERSONAL so an instant meeting gets the saved room rather than a
  // built-in one — the panel's fallback button only exists for a link it
  // cannot embed.
  const org = await prisma.organization.create({ data: { name: 'Huddle Org', slug, conferencingPolicy: 'PREFER_PERSONAL' } });
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Huddle Mentor', org.id);
  const mentee = await seedUser(uniqueEmail(`${prefix}-mentee`), 'x', 'MENTEE', 'Huddle Mentee', org.id);
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id } });
  const cleanup = async () => {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  };
  return { org, mentor, mentorEmail, mentee, rel, cleanup };
}

test('the huddle link is accepted as the personal room on /account, and the hint says where it opens', async ({ page }) => {
  // Against `next dev` the first visit of /account compiles the route under
  // the test's clock; the same test is a few seconds on CI's `next start`.
  test.slow();
  const s = await seedHuddleOrg('huddle-acct');
  try {
    await signInAndSettle(page, s.mentorEmail, 'MentorPass123', '/mentor');
    await gotoSettled(page, '/account');
    // Enabled, not merely visible: the controls stay disabled until GET
    // /api/profile has answered, and that answer resets the personal-room box
    // to the stored value — a value typed before it lands is wiped.
    await expect(page.getByTestId('timezone-select')).toBeEnabled({ timeout: 30_000 });

    const input = page.getByTestId('personal-room-input');
    await input.fill(HUDDLE);
    // Said before anything is saved: the link opens in a tab, in Slack Huddle.
    await expect(page.getByTestId('meet-link-hint')).toContainText('Slack Huddle');
    await page.getByTestId('personal-room-save').click();
    await expect(page.getByTestId('personal-room-saved')).toBeVisible();
    await expect(page.getByTestId('meet-link-refusal')).toHaveCount(0);

    const stored = await prisma.user.findUnique({ where: { id: s.mentor.id }, select: { personalMeetingUrl: true } });
    expect(stored?.personalMeetingUrl).toBe(HUDDLE);
  } finally {
    await s.cleanup();
  }
});

test('a meeting on the huddle link opens the side panel with "Open in Slack Huddle" and no embed', async ({ page }) => {
  test.slow(); // same reason as above: /mentor/mentees + the instant route compile on first use
  const s = await seedHuddleOrg('huddle-panel');
  await prisma.user.update({ where: { id: s.mentor.id }, data: { personalMeetingUrl: HUDDLE } });
  try {
    await signInAndSettle(page, s.mentorEmail, 'MentorPass123', '/mentor');
    await gotoSettled(page, '/mentor/mentees');

    // The card's own button: under PREFER_PERSONAL the instant meeting carries
    // the huddle link, and the side panel — which cannot frame Slack — offers
    // to open it in Slack Huddle.
    await page.getByTestId(`start-meeting-${s.rel.id}`).click();
    const topic = page.getByTestId('instant-meeting-topic');
    await expect(topic).toBeVisible();
    await topic.fill('Huddle sync');
    await page.getByTestId('instant-meeting-confirm').click();

    await expect(page.getByTestId('meeting-side-panel')).toBeVisible({ timeout: 15_000 });
    const open = page.getByTestId('meeting-open-external');
    await expect(open).toHaveAttribute('href', HUDDLE);
    await expect(open).toContainText('Slack Huddle');
    // No free-room fallback: that escape hatch is for our own JaaS rooms only.
    await expect(page.getByTestId('meeting-free-fallback')).toHaveCount(0);

    const meeting = await prisma.meeting.findFirst({ where: { relationId: s.rel.id } });
    expect(meeting?.meetLink).toBe(HUDDLE);
  } finally {
    await s.cleanup();
  }
});
