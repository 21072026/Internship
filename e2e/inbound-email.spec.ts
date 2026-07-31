import { test, expect } from '@playwright/test';
import { createHmac } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Mirror src/lib/replyToken.ts so the test can craft valid/invalid tokens.
const secret = () => process.env.NEXTAUTH_SECRET || 'dev-secret';
const makeToken = (relationId: string) =>
  `${relationId}.${createHmac('sha256', secret()).update(relationId).digest('hex').slice(0, 32)}`;

test('inbound email reply is routed to the thread (token + sender verified)', async ({ request }) => {
  const mentorEmail = uniqueEmail('inb-mentor');
  const menteeEmail = uniqueEmail('inb-mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Inb Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Inb Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const token = makeToken(rel.id);

  try {
    // Valid: correct token + participant sender → message created, quoted text stripped.
    const ok = await request.post('/api/inbound-email', {
      data: { to: `reply+${token}@crm.ersah.in`, from: `Inb Mentee <${menteeEmail}>`, text: 'Thanks, see you then!\n\nOn Mon someone wrote:\n> earlier message' },
    });
    expect(ok.status()).toBe(200);
    await expect.poll(async () => prisma.message.count({ where: { relationId: rel.id, channel: 'EMAIL', senderId: mentee.id } })).toBeGreaterThan(0);
    const msg = await prisma.message.findFirst({ where: { relationId: rel.id, senderId: mentee.id } });
    expect(msg?.body).toBe('Thanks, see you then!');
    await expect.poll(async () => prisma.notification.count({ where: { userId: mentor.id, type: 'message' } })).toBeGreaterThan(0);

    // Tampered token → rejected.
    const bad = await request.post('/api/inbound-email', {
      data: { to: `reply+${rel.id}.deadbeefdeadbeefdeadbeefdeadbeef@crm.ersah.in`, from: menteeEmail, text: 'hack' },
    });
    expect(bad.status()).toBe(400);

    // Valid token but sender is not a participant → rejected.
    const stranger = await request.post('/api/inbound-email', {
      data: { to: `reply+${token}@crm.ersah.in`, from: 'stranger@evil.com', text: 'spoof' },
    });
    expect(stranger.status()).toBe(403);

    // Still only one message from the mentee.
    expect(await prisma.message.count({ where: { relationId: rel.id } })).toBe(1);

    // Same email delivered twice (IMAP is at-least-once, and a catch-all can
    // hand over two copies) → threaded once, thanks to the Message-ID guard.
    const messageId = `<replay-${rel.id}@mail.example>`;
    for (const attempt of [1, 2]) {
      const res = await request.post('/api/inbound-email', {
        data: { to: `reply+${token}@crm.ersah.in`, from: menteeEmail, text: 'Sent twice by the mail server', messageId },
      });
      expect(res.status()).toBe(200);
      // The first delivery creates it; the replay reports created:false.
      expect((await res.json()).created).toBe(attempt === 1);
    }
    expect(await prisma.message.count({ where: { relationId: rel.id, inboundMessageId: messageId } })).toBe(1);
    expect(await prisma.message.count({ where: { relationId: rel.id } })).toBe(2);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
