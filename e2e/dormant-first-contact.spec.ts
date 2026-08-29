import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { getAttentionItems } from '../src/lib/mentorAttention';

test.afterAll(async () => prisma.$disconnect());

// #1499 — people who sign up, get one message and are never heard from again
// used to sit in the mentor's attention queue forever ("no recent contact" +
// "no open goal"), which is how a queue ends up 26 rows long with nothing in it
// worth doing. They are dropped from the queue; anything that looks like a live
// thread puts them straight back.
test('a first-stage mentee who was messaged and never replied leaves the attention queue', async () => {
  const mentorEmail = uniqueEmail('dormant-mentor');
  const menteeEmail = uniqueEmail('dormant-mentee');
  const freshEmail = uniqueEmail('dormant-fresh');
  try {
    const mentor = await seedUser(mentorEmail, 'DormantPass123', 'MENTOR', 'Dormant Mentor');
    const mentee = await seedUser(menteeEmail, 'DormantPass123', 'MENTEE', 'Dormant Mentee');
    const fresh = await seedUser(freshEmail, 'DormantPass123', 'MENTEE', 'Never Contacted Mentee');
    const long = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);

    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    // Nobody has written to them yet: the first message is still the mentor's
    // to send, so this one must stay on the list.
    const untouched = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: fresh.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });

    const before = await getAttentionItems(mentor.id);
    expect(before.items.map((i) => i.relationId)).toContain(relation.id);
    expect(before.dormantCount).toBe(0);

    // The mentor reached out four months ago and heard nothing back.
    const outreach = await prisma.interactionLog.create({
      data: { relationId: relation.id, date: long, notes: 'Sent a welcome email', type: 'Email' },
    });
    const dormant = await getAttentionItems(mentor.id);
    expect(dormant.items.map((i) => i.relationId)).not.toContain(relation.id);
    expect(dormant.items.map((i) => i.relationId)).toContain(untouched.id);
    expect(dormant.dormantCount).toBe(1);

    // A reply from the mentee is a live thread — back on the list.
    const reply = await prisma.message.create({
      data: { relationId: relation.id, senderId: mentee.id, body: 'Sorry for the late reply!' },
    });
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).toContain(relation.id);
    await prisma.message.delete({ where: { id: reply.id } });

    // So is an unanswered question, a pending meeting request, and a deadline
    // the mentor deliberately put on the stage.
    const question = await prisma.mentorQuestion.create({
      data: { relationId: relation.id, askedById: mentee.id, question: 'Is the internship still open?' },
    });
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).toContain(relation.id);
    await prisma.mentorQuestion.delete({ where: { id: question.id } });

    const meetingRequest = await prisma.meetingRequest.create({
      data: { relationId: relation.id, requestedById: mentee.id, topic: 'Intro call', proposedAt: new Date() },
    });
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).toContain(relation.id);
    await prisma.meetingRequest.delete({ where: { id: meetingRequest.id } });

    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { stageDeadline: long } });
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).toContain(relation.id);
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { stageDeadline: null } });

    // Advancing the stage means the process is live again, whatever the silence.
    await prisma.mentorshipRelation.update({ where: { id: relation.id }, data: { pipelineStatus: 'INTERVIEW_PENDING_250' } });
    const advanced = await getAttentionItems(mentor.id);
    expect(advanced.items.map((i) => i.relationId)).toContain(relation.id);
    expect(advanced.dormantCount).toBe(0);

    await prisma.interactionLog.delete({ where: { id: outreach.id } });
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(freshEmail);
  }
});

// Reaching out is not the same as logging that you reached out. A mentor wrote
// four times through the in-app messenger and never touched the interaction
// form, so the relation had no InteractionLog at all — and the rule, which only
// looked at that table, kept the mentee in the queue with "no recent contact"
// forever. The outreach date is the later of the last logged interaction and
// the last message from anybody who is not the mentee.
test('messenger-only outreach counts, and a reply only counts when it came after it', async () => {
  const mentorEmail = uniqueEmail('messenger-mentor');
  const menteeEmail = uniqueEmail('messenger-mentee');
  try {
    const mentor = await seedUser(mentorEmail, 'MessengerPass123', 'MENTOR', 'Messenger Mentor');
    const mentee = await seedUser(menteeEmail, 'MessengerPass123', 'MENTEE', 'Messaged Mentee');
    const relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    });
    const at = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Nobody has written at all: the first message is still the mentor's to send.
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).toContain(relation.id);

    // The mentor writes twice through the messenger — no interaction log anywhere.
    await prisma.message.create({ data: { relationId: relation.id, senderId: mentor.id, body: 'Hoş geldin', createdAt: at(40) } });
    await prisma.message.create({ data: { relationId: relation.id, senderId: mentor.id, body: 'Ne zaman müsaitsin?', createdAt: at(25) } });
    expect(await prisma.interactionLog.count({ where: { relationId: relation.id } })).toBe(0);
    const dormant = await getAttentionItems(mentor.id);
    expect(dormant.items.map((i) => i.relationId)).not.toContain(relation.id);
    expect(dormant.dormantCount).toBe(1);

    // A reply from BEFORE the last outreach is not an answer to it: the mentee
    // talked in month one, was written to in month two and said nothing since.
    const oldReply = await prisma.message.create({
      data: { relationId: relation.id, senderId: mentee.id, body: 'Merhaba!', createdAt: at(35) },
    });
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).not.toContain(relation.id);

    // A reply after it puts the ball back in the mentor's court.
    await prisma.message.update({ where: { id: oldReply.id }, data: { createdAt: at(3) } });
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).toContain(relation.id);

    // And an outreach inside the grace period is not silence yet.
    await prisma.message.deleteMany({ where: { relationId: relation.id } });
    await prisma.message.create({ data: { relationId: relation.id, senderId: mentor.id, body: 'Merhaba', createdAt: at(2) } });
    expect((await getAttentionItems(mentor.id)).items.map((i) => i.relationId)).toContain(relation.id);
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
