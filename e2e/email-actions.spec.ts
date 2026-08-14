import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { replyAddress } from '../src/lib/replyToken';
import { makeEmailActionToken, EMAIL_REACTION_EMOJIS } from '../src/lib/emailActionToken';
import { E2E_INBOUND_SECRET } from '../playwright.config';

// CI serves a production build and the inbound webhook's fail-open is dev-only
// (#870), so the header is required — same as e2e/inbound-email.spec.ts.
const authed = { 'x-inbound-secret': E2E_INBOUND_SECRET };

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1204: a notification email was a dead end — you could reply, but the reply
// never marked anything read, so the hourly digest kept resurfacing a
// conversation that had already been answered. These three cases cover the way
// back out: replying, the explicit "mark as read" link, and a one-click
// reaction.

async function seedThread(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'EA Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'EA Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  return { mentor, mentee, relation };
}

// Three unread messages from the mentor, waiting on the mentee.
async function seedUnread(relationId: string, senderId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const m = await prisma.message.create({
      data: { relationId, senderId, channel: 'IN_APP', body: `unread ${i}` },
    });
    ids.push(m.id);
  }
  return ids;
}

test('replying by email marks that conversation — and everything before it — as read', async ({ request }) => {
  const { mentor, mentee, relation } = await seedThread('ea-reply');
  try {
    const ids = await seedUnread(relation.id, mentor.id, 3);
    expect(await prisma.message.count({ where: { id: { in: ids }, readAt: null } })).toBe(3);

    // The mentee answers from their mailbox: exactly what the IMAP bridge posts.
    const res = await request.post('/api/inbound-email', {
      headers: authed,
      data: {
        to: replyAddress(relation.id, mentee.id),
        from: mentee.email,
        text: 'tamam abi, hallederim',
        messageId: `<ea-reply-${Date.now()}@test.local>`,
      },
    });
    expect(res.ok()).toBeTruthy();

    // The reply landed…
    const reply = await prisma.message.findFirst({
      where: { relationId: relation.id, senderId: mentee.id, channel: 'EMAIL' },
    });
    expect(reply).not.toBeNull();

    // …and the three messages it answered are no longer unread, so the digest
    // will not pick them up again. This is the actual bug being fixed.
    expect(await prisma.message.count({ where: { id: { in: ids }, readAt: null } })).toBe(0);
  } finally {
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentor.email);
  }
});

test('the "mark as read" link in an email clears the conversation', async ({ page }) => {
  const { mentor, mentee, relation } = await seedThread('ea-read');
  try {
    const ids = await seedUnread(relation.id, mentor.id, 2);

    const token = makeEmailActionToken({ kind: 'read', relationId: relation.id, userId: mentee.id });
    await page.goto(`/m/${encodeURIComponent(token)}`);

    await expect(page.getByTestId('email-action-read')).toBeVisible({ timeout: 15_000 });
    expect(await prisma.message.count({ where: { id: { in: ids }, readAt: null } })).toBe(0);
  } finally {
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentor.email);
  }
});

test('an emoji link reacts to the exact message it was minted for', async ({ page }) => {
  const { mentor, mentee, relation } = await seedThread('ea-react');
  try {
    const ids = await seedUnread(relation.id, mentor.id, 2);
    // Deliberately the FIRST message, while a newer one exists: the token is
    // bound to a message id, so a later arrival must not steal the reaction.
    const target = ids[0];

    const token = makeEmailActionToken({ kind: 'react', messageId: target, userId: mentee.id, emojiIndex: 0 });
    await page.goto(`/m/${encodeURIComponent(token)}`);
    await expect(page.getByTestId('email-action-reacted')).toBeVisible({ timeout: 15_000 });

    const reactions = await prisma.messageReaction.findMany({ where: { userId: mentee.id } });
    expect(reactions).toHaveLength(1);
    expect(reactions[0].messageId).toBe(target);
    expect(reactions[0].emoji).toBe(EMAIL_REACTION_EMOJIS[0]);

    // Reacting is reading — otherwise the thread would go straight back into
    // the digest the user just answered from their inbox.
    expect(await prisma.message.count({ where: { id: { in: ids }, readAt: null } })).toBe(0);
  } finally {
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentor.email);
  }
});

test('a tampered email-action token is rejected', async ({ request }) => {
  const { mentor, mentee, relation } = await seedThread('ea-forge');
  try {
    const ids = await seedUnread(relation.id, mentor.id, 1);
    const valid = makeEmailActionToken({ kind: 'read', relationId: relation.id, userId: mentee.id });
    // Re-point the payload at the mentor while keeping the mentee's signature.
    const forged = `k~${relation.id}~${mentor.id}.${valid.split('.').pop()}`;

    const res = await request.post('/api/email-action', { data: { token: forged } });
    expect(res.status()).toBe(400);
    expect(await prisma.message.count({ where: { id: { in: ids }, readAt: null } })).toBe(1);
  } finally {
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentor.email);
  }
});
