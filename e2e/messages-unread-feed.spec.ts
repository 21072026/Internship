import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// The header's unread-message count (#3593). The shell mounts two
// <MessagesButton>s (mobile bar + desktop strip); each fetched
// /api/messages/unread on its own, so every signed-in page asked twice. One
// shared count now serves both.
test('one page load asks for the unread-message count once, and both badges agree', async ({ page }) => {
  const pw = 'MsgFeed123!';
  const mentorEmail = uniqueEmail('msgfeed-mentor');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'MsgFeed Mentor');
  const mentee = await seedUser(uniqueEmail('msgfeed-mentee'), pw, 'MENTEE', 'MsgFeed Mentee');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  await prisma.message.create({ data: { relationId: relation.id, senderId: mentee.id, body: 'Unread for the badge' } });
  try {
    await signInAndSettle(page, mentorEmail, pw, '/mentor');
    await page.waitForLoadState('networkidle');
    const calls: string[] = [];
    page.on('request', (req) => {
      if (new URL(req.url()).pathname === '/api/messages/unread' && req.method() === 'GET') calls.push(req.url());
    });
    await gotoSettled(page, '/mentor/interactions');
    await page.waitForLoadState('networkidle');
    expect(calls).toHaveLength(1);
    const badges = page.getByTestId('messages-unread-badge');
    await expect(badges).toHaveCount(2);
    await expect(badges.first()).toHaveText('1');
    await expect(badges.last()).toHaveText('1');
  } finally {
    await prisma.message.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await prisma.user.deleteMany({ where: { id: { in: [mentor.id, mentee.id] } } });
  }
});
