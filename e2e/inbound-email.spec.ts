import { test, expect } from '@playwright/test';
import { createHmac } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { E2E_INBOUND_SECRET } from '../playwright.config';

// The webhook's shared secret is mandatory outside development (#870), and CI
// serves a production build — so every call here carries it. That is also the
// production shape: the token gate below is the *second* factor, not the only
// one.
const authed = { 'x-inbound-secret': E2E_INBOUND_SECRET };

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Mirror src/lib/replyToken.ts so the test can craft valid/invalid tokens.
const secret = () => process.env.NEXTAUTH_SECRET || 'dev-secret';
const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('hex').slice(0, 32);
// Legacy shape: relation only, no recipient. Still minted by nothing, but tokens
// in already-delivered mail look like this, so it must keep working.
const makeToken = (relationId: string) => `${relationId}.${sign(relationId)}`;
// Current shape: names the thread AND the user the notification was sent to.
const makeScopedToken = (relationId: string, userId: string) =>
  `${relationId}~${userId}.${sign(`${relationId}~${userId}`)}`;

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
      headers: authed,
      data: { to: `reply+${token}@crm.ersah.in`, from: `Inb Mentee <${menteeEmail}>`, text: 'Thanks, see you then!\n\nOn Mon someone wrote:\n> earlier message' },
    });
    expect(ok.status()).toBe(200);
    await expect.poll(async () => prisma.message.count({ where: { relationId: rel.id, channel: 'EMAIL', senderId: mentee.id } })).toBeGreaterThan(0);
    const msg = await prisma.message.findFirst({ where: { relationId: rel.id, senderId: mentee.id } });
    expect(msg?.body).toBe('Thanks, see you then!');
    await expect.poll(async () => prisma.notification.count({ where: { userId: mentor.id, type: 'message' } })).toBeGreaterThan(0);

    // No shared secret → refused before the token is even looked at (#870).
    const anon = await request.post('/api/inbound-email', {
      data: { to: `reply+${token}@crm.ersah.in`, from: menteeEmail, text: 'no secret' },
    });
    expect(anon.status()).toBe(401);

    // Tampered token → rejected.
    const bad = await request.post('/api/inbound-email', {
      headers: authed,
      data: { to: `reply+${rel.id}.deadbeefdeadbeefdeadbeefdeadbeef@crm.ersah.in`, from: menteeEmail, text: 'hack' },
    });
    expect(bad.status()).toBe(400);

    // Legacy token (no recipient) + sender is not a participant → rejected,
    // because nothing else identifies the writer.
    const stranger = await request.post('/api/inbound-email', {
      headers: authed,
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
        headers: authed,
        data: { to: `reply+${token}@crm.ersah.in`, from: menteeEmail, text: 'Sent twice by the mail server', messageId },
      });
      expect(res.status()).toBe(200);
      // The first delivery creates it; the replay reports created:false.
      expect((await res.json()).created).toBe(attempt === 1);
    }
    expect(await prisma.message.count({ where: { relationId: rel.id, inboundMessageId: messageId } })).toBe(1);
    expect(await prisma.message.count({ where: { relationId: rel.id } })).toBe(2);

    // Quote attribution lines other than "On … wrote:" are trimmed too — this
    // exact shape arrived from a real client and used to leak into the thread.
    const quoted = await request.post('/api/inbound-email', {
      headers: authed,
      data: {
        to: `reply+${token}@crm.ersah.in`,
        from: menteeEmail,
        text: 'cevap veriyorum\n\nJuly 2, 2026 at 3:50 PM, noreply@crm.ersah.in wrote:\n> earlier message',
        messageId: `<attribution-${rel.id}@mail.example>`,
      },
    });
    expect(quoted.status()).toBe(200);
    const quotedMsg = await prisma.message.findFirst({ where: { inboundMessageId: `<attribution-${rel.id}@mail.example>` } });
    expect(quotedMsg?.body).toBe('cevap veriyorum');

    // A recipient-scoped token threads the reply even when it arrives from a
    // completely different address — the real case: the notification is
    // forwarded to a personal mailbox and answered with that identity, so From
    // never matches the profile email. Attributed to the user named in the token.
    const scoped = makeScopedToken(rel.id, mentee.id);
    const forwardedId = `<forwarded-${rel.id}@mail.example>`;
    const forwarded = await request.post('/api/inbound-email', {
      headers: authed,
      data: {
        to: `reply+${scoped}@crm.ersah.in`,
        from: 'personal-address-not-on-file@gmail.com',
        text: 'ok',
        messageId: forwardedId,
      },
    });
    expect(forwarded.status()).toBe(200);
    const forwardedMsg = await prisma.message.findFirst({ where: { inboundMessageId: forwardedId } });
    expect(forwardedMsg?.senderId).toBe(mentee.id);
    expect(forwardedMsg?.body).toBe('ok');

    // The fallback is bounded to the token's own recipient: a signed token naming
    // somebody who is NOT in this thread still gets nothing.
    const outsider = await seedUser(uniqueEmail('inb-outsider'), 'x', 'MENTEE', 'Inb Outsider');
    try {
      const spoof = await request.post('/api/inbound-email', {
        headers: authed,
        data: {
          to: `reply+${makeScopedToken(rel.id, outsider.id)}@crm.ersah.in`,
          from: 'stranger@evil.com',
          text: 'spoof',
        },
      });
      expect(spoof.status()).toBe(403);
    } finally {
      await cleanupByEmail(outsider.email);
    }
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
