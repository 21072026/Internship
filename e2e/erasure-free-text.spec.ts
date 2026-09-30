import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
// Static imports, not `await import()` inside a test: Playwright resolves the
// `@/…` path alias when it transforms the spec's import graph, but a dynamic
// import is resolved by Node at runtime, which knows nothing about tsconfig
// paths (see e2e/email-hardening.spec.ts).
import { anonymizeUser, hardDeleteUser } from '../src/lib/accountErasure';

/**
 * Erasure actually erases (#2052).
 *
 * `anonymizeUser()` used to rewrite the `User` row, delete the uploaded files
 * and stop — leaving every free-text field the person had ever typed, and
 * everything typed about them, sitting in the database under a row that claimed
 * to be anonymous. This is the acceptance evidence the DPA (#2029) points at:
 * seed a full paper trail, run BOTH erasure paths, then ask the database
 * directly whether any of the seeded PII is still findable.
 *
 * Not `@smoke`: it seeds ~a dozen rows across eight tables and is not a
 * runtime-critical path.
 *
 * #2106 extended the paper trail to the rest of the per-person inventory in
 * scripts/sanitize-db.mjs (evaluations, weekly reports, questions, meeting
 * requests and titles, goals, join requests, company notes, offers, stage
 * reasons, the person's own bell). NOT covered because the code deliberately
 * does not reach it — see the COVERAGE block in src/lib/accountErasure.ts: a
 * free-standing `PersonalNote` with `meetingId: null`, group/project meeting
 * notes, other people's notifications naming the person, and the audit trail.
 */

const PASSWORD = 'ErasurePass123';

/** Everything the seed writes, so one query per table can ask "is it gone?". */
interface Seeded {
  tag: string;
  pii: {
    message: string;
    conversationMessage: string;
    support: string;
    supportSubject: string;
    meetingNote: string;
    conversationNote: string;
    ownNote: string;
    relationNote: string;
    interactionNotes: string;
    interactionSubject: string;
    request: string;
    reEngage: string;
    evalComment: string;
    evalExcerpt: string;
    weeklySummary: string;
    weeklyBlockers: string;
    weeklyMentorComment: string;
    question: string;
    answer: string;
    meetingTopic: string;
    meetingTitle: string;
    cancelReason: string;
    goal: string;
    joinMessage: string;
    joinDecision: string;
    interestNote: string;
    interviewNote: string;
    interviewDecline: string;
    offerComp: string;
    offerDecline: string;
    statusNote: string;
    notification: string;
  };
  mentorEmail: string;
  menteeEmail: string;
  mentorId: string;
  menteeId: string;
  relationId: string;
  conversationId: string;
  ticketId: string;
  mentorMessageId: string;
  menteeMessageIds: string[];
  interactionLogId: string;
  meetingNoteId: string;
  conversationNoteId: string;
  companyId: string;
  projectId: string;
  evaluationId: string;
  weeklyReportId: string;
  questionId: string;
}

async function seedPaperTrail(prefix: string): Promise<Seeded> {
  // Every seeded string carries a per-run tag, so a `contains` query cannot
  // accidentally match another spec's leftovers (or another shard's).
  const tag = crypto.randomBytes(4).toString('hex');
  const pii = {
    message: `my number is 0555 ${tag} 11`,
    conversationMessage: `I live at Kadikoy ${tag} street 4`,
    support: `cannot sign in, my address is ${tag} avenue`,
    supportSubject: `login trouble ${tag}`,
    meetingNote: `talked about their divorce ${tag}`,
    conversationNote: `they cried on the call ${tag}`,
    ownNote: `my own reminder ${tag}`,
    relationNote: `mentor impression ${tag}`,
    interactionNotes: `phoned them on their mobile ${tag}`,
    interactionSubject: `first call ${tag}`,
    request: `please match me, I am ${tag}`,
    reEngage: `call back in September ${tag}`,
    evalComment: `anxious in interviews ${tag}`,
    evalExcerpt: `she changed my life ${tag}`,
    weeklySummary: `this week my father was ill ${tag}`,
    weeklyBlockers: `no laptop at home ${tag}`,
    weeklyMentorComment: `seems burnt out ${tag}`,
    question: `can I tell HR about my ADHD ${tag}`,
    answer: `yes, and here is how ${tag}`,
    meetingTopic: `talk about my visa ${tag}`,
    meetingTitle: `Mock interview with them ${tag}`,
    cancelReason: `they were in hospital ${tag}`,
    goal: `move out of my parents' flat ${tag}`,
    joinMessage: `I have time after my shifts ${tag}`,
    joinDecision: `too junior for this ${tag}`,
    interestNote: `strong but asked for relocation help ${tag}`,
    interviewNote: `bring your passport ${tag}`,
    interviewDecline: `it clashes with my exam ${tag}`,
    offerComp: `2 400 net, as they asked ${tag}`,
    offerDecline: `family reasons ${tag}`,
    statusNote: `paused while they recover ${tag}`,
    notification: `Erasure Mentor replied to you ${tag}`,
  };

  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Erasure Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Erasure Mentee');
  await prisma.user.update({
    where: { id: mentee.id },
    data: { city: 'Istanbul', country: 'TR', referralSource: `a friend ${tag}`, reEngageNote: pii.reEngage },
  });

  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  // A 1:1 conversation as well as the legacy relation thread: a
  // conversation-layer message has `relationId: null`, so it is NOT reached by
  // the relation cascade a hard delete runs — and `Message.senderId` has no FK
  // to `User`, so nothing else reaches it either.
  const conversation = await prisma.conversation.create({
    data: {
      type: 'DIRECT',
      directKey: [mentor.id, mentee.id].sort().join('|'),
      participants: { create: [{ userId: mentor.id }, { userId: mentee.id }] },
    },
  });

  const relationMessage = await prisma.message.create({
    data: { relationId: relation.id, senderId: mentee.id, body: pii.message },
  });
  const conversationMessage = await prisma.message.create({
    data: { conversationId: conversation.id, senderId: mentee.id, body: pii.conversationMessage },
  });
  await prisma.messageAttachment.createMany({
    data: [relationMessage.id, conversationMessage.id].map((messageId) => ({
      messageId,
      filename: 'id-card.png',
      contentType: 'image/png',
      size: 3,
      data: Buffer.from('png'),
    })),
  });
  // The other side of the thread — must survive untouched, or the mentor's
  // conversation turns into a blank page instead of a tombstoned one.
  const mentorMessage = await prisma.message.create({
    data: { conversationId: conversation.id, senderId: mentor.id, body: `noted, see you then (${tag})` },
  });

  // Support thread the person opened themselves. `SupportTicket.subject` is a
  // verbatim copy of the first 80 characters of their own first message
  // (src/app/api/support/route.ts), so it is PII too.
  const ticket = await prisma.supportTicket.create({
    data: { requesterId: mentee.id, subject: pii.supportSubject },
  });
  const supportMessage = await prisma.supportMessage.create({
    data: { ticketId: ticket.id, senderId: mentee.id, body: pii.support },
  });
  await prisma.supportAttachment.create({
    data: {
      messageId: supportMessage.id,
      filename: 'screenshot.png',
      contentType: 'image/png',
      size: 3,
      data: Buffer.from('png'),
    },
  });

  // A note the mentor took in a meeting with this mentee. Keyed to the note's
  // AUTHOR, so no cascade from the subject ever reaches it; `meetingId` is the
  // only link back to them — and it is `SetNull`, so it disappears the moment
  // the relation (and with it the meeting) is deleted.
  const meeting = await prisma.meeting.create({
    data: {
      relationId: relation.id,
      title: `1:1 ${tag}`,
      rsvpToken: crypto.randomBytes(24).toString('hex'),
      createdById: mentor.id,
    },
  });
  const meetingNote = await prisma.personalNote.create({
    data: { userId: mentor.id, meetingId: meeting.id, category: 'MEETING', body: pii.meetingNote },
  });
  // The other half of the note lookup: a meeting hung off the DIRECT (1:1)
  // conversation rather than off the relation (`relationId: null` — #1051 made
  // that legal). It is reached only through
  // `meeting.conversation.participants`, the second branch of the `OR` in
  // scrubFreeTextOps, and nothing else in this repo covers that branch.
  const conversationMeeting = await prisma.meeting.create({
    data: {
      conversationId: conversation.id,
      title: `catch-up ${tag}`,
      rsvpToken: crypto.randomBytes(24).toString('hex'),
      createdById: mentor.id,
    },
  });
  const conversationNote = await prisma.personalNote.create({
    data: {
      userId: mentor.id,
      meetingId: conversationMeeting.id,
      category: 'MEETING',
      body: pii.conversationNote,
    },
  });
  // The person's own private note.
  await prisma.personalNote.create({ data: { userId: mentee.id, body: pii.ownNote } });

  await prisma.relationNote.create({
    data: { relationId: relation.id, authorId: mentor.id, body: pii.relationNote },
  });
  const interactionLog = await prisma.interactionLog.create({
    data: {
      relationId: relation.id,
      date: new Date(),
      type: 'Meeting',
      subject: pii.interactionSubject,
      notes: pii.interactionNotes,
    },
  });
  await prisma.mentorshipRequest.create({ data: { menteeId: mentee.id, message: pii.request } });

  // ── The rest of the sanitize-db inventory (#2106) ─────────────────────────
  const org = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
  });
  // Written by the MENTOR about the mentee: the "about" rule, and — for the
  // mentor-erasure test below — the "as author" rule.
  const evaluation = await prisma.evaluation.create({
    data: { relationId: relation.id, authorId: mentor.id, comment: pii.evalComment, publicExcerpt: pii.evalExcerpt },
  });
  const weeklyReport = await prisma.weeklyReport.create({
    data: {
      orgId: org.id,
      relationId: relation.id,
      weekStart: new Date(),
      summary: pii.weeklySummary,
      blockers: pii.weeklyBlockers,
      mentorComment: pii.weeklyMentorComment,
      reviewedById: mentor.id,
    },
  });
  const question = await prisma.mentorQuestion.create({
    data: { relationId: relation.id, askedById: mentee.id, question: pii.question, answer: pii.answer },
  });
  await prisma.meetingRequest.create({
    data: { relationId: relation.id, requestedById: mentee.id, topic: pii.meetingTopic, proposedAt: new Date() },
  });
  // A meeting title that names the person, on the 1:1 conversation meeting —
  // the one a hard delete does not cascade.
  await prisma.meeting.update({
    where: { id: conversationMeeting.id },
    data: { title: pii.meetingTitle, cancelReason: pii.cancelReason },
  });
  await prisma.goal.create({ data: { relationId: relation.id, title: 'Goal', description: pii.goal } });
  const project = await prisma.project.create({
    data: { name: `Erasure project ${tag}`, ownerType: 'MENTOR', ownerUserId: mentor.id },
  });
  await prisma.projectJoinRequest.create({
    data: { projectId: project.id, userId: mentee.id, message: pii.joinMessage, decisionNote: pii.joinDecision },
  });
  const company = await prisma.company.create({ data: { name: `Erasure Co ${tag}`, orgId: org.id } });
  await prisma.companyInterest.create({
    data: { companyId: company.id, menteeId: mentee.id, status: 'INTERESTED', note: pii.interestNote },
  });
  const requisition = await prisma.requisition.create({
    data: { orgId: org.id, companyId: company.id, title: 'Junior developer', openings: 1 },
  });
  await prisma.interviewRequest.create({
    data: {
      requisitionId: requisition.id,
      menteeId: mentee.id,
      companyId: company.id,
      orgId: org.id,
      note: pii.interviewNote,
      declineNote: pii.interviewDecline,
    },
  });
  await prisma.offer.create({
    data: {
      relationId: relation.id,
      position: 'Junior developer',
      createdById: mentor.id,
      compensationNote: pii.offerComp,
      declineNote: pii.offerDecline,
    },
  });
  await prisma.statusChange.create({
    data: {
      relationId: relation.id,
      fromStatus: 'APPLICATION_100',
      toStatus: 'APPROVAL_PENDING_220',
      changedById: mentor.id,
      reasonNote: pii.statusNote,
    },
  });
  await prisma.notification.create({ data: { userId: mentee.id, type: 'message.new', text: pii.notification } });

  return {
    tag,
    pii,
    mentorEmail,
    menteeEmail,
    mentorId: mentor.id,
    menteeId: mentee.id,
    relationId: relation.id,
    conversationId: conversation.id,
    ticketId: ticket.id,
    mentorMessageId: mentorMessage.id,
    menteeMessageIds: [relationMessage.id, conversationMessage.id],
    interactionLogId: interactionLog.id,
    meetingNoteId: meetingNote.id,
    conversationNoteId: conversationNote.id,
    companyId: company.id,
    projectId: project.id,
    evaluationId: evaluation.id,
    weeklyReportId: weeklyReport.id,
    questionId: question.id,
  };
}

async function cleanup(s: Seeded) {
  // Conversation-layer messages are the one thing that outlives both the user
  // and the conversation (`Conversation` → `Message` is SetNull), so they are
  // removed by hand or the row leaks out of the test.
  await prisma.messageAttachment.deleteMany({ where: { message: { conversationId: s.conversationId } } });
  await prisma.message.deleteMany({ where: { conversationId: s.conversationId } });
  await prisma.message.deleteMany({ where: { senderId: { in: [s.menteeId, s.mentorId] } } });
  await prisma.conversation.deleteMany({ where: { id: s.conversationId } });
  await prisma.personalNote.deleteMany({ where: { userId: { in: [s.menteeId, s.mentorId] } } });
  // The seeded rows go by ID, not by e-mail: the anonymise path has already
  // rewritten the mentee's address to erased-<id>@erased.local, so
  // `cleanupByEmail(menteeEmail)` matches nothing and the anonymised row would
  // stay behind — with its support ticket sitting in the admin queue and its
  // pending mentorship request in the approval queue for every later spec in
  // the run. e2e/candidate-erasure.spec.ts deletes by id after the same call
  // for the same reason. Relations first: `MentorshipRelation.mentor/mentee`
  // are FK-restrict, so the user rows cannot go while a relation points at them.
  // Company-side and project rows first: they hang off the users and the
  // company, and an interview request / offer blocks its parents otherwise.
  await prisma.interviewRequest.deleteMany({ where: { companyId: s.companyId } });
  await prisma.companyInterest.deleteMany({ where: { companyId: s.companyId } });
  await prisma.requisition.deleteMany({ where: { companyId: s.companyId } });
  await prisma.offer.deleteMany({ where: { relation: { mentorId: s.mentorId } } });
  await prisma.statusChange.deleteMany({ where: { relation: { mentorId: s.mentorId } } });
  await prisma.company.deleteMany({ where: { id: s.companyId } });
  await prisma.projectJoinRequest.deleteMany({ where: { projectId: s.projectId } });
  await prisma.project.deleteMany({ where: { id: s.projectId } });
  await prisma.meeting.deleteMany({ where: { conversationId: s.conversationId } });
  await prisma.mentorshipRelation.deleteMany({
    where: { OR: [{ menteeId: s.menteeId }, { mentorId: s.mentorId }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: [s.menteeId, s.mentorId] } } });
  await cleanupByEmail(s.menteeEmail);
  await cleanupByEmail(s.mentorEmail);
}

/**
 * The one question that matters, asked of the database rather than of the UI:
 * does any seeded free-text string still exist anywhere?
 *
 * `MessageAttachment.data` / `SupportAttachment.data` are `Bytes` and cannot be
 * searched, so those are asserted as row counts — the rows must be gone.
 */
async function expectNoFreeTextLeft(s: Seeded) {
  const p = s.pii;
  expect(await prisma.message.count({ where: { body: { contains: p.message } } })).toBe(0);
  expect(await prisma.message.count({ where: { body: { contains: p.conversationMessage } } })).toBe(0);
  expect(await prisma.messageAttachment.count({ where: { messageId: { in: s.menteeMessageIds } } })).toBe(0);
  expect(await prisma.supportMessage.count({ where: { body: { contains: p.support } } })).toBe(0);
  expect(await prisma.supportTicket.count({ where: { subject: { contains: p.supportSubject } } })).toBe(0);
  expect(await prisma.supportAttachment.count({ where: { message: { senderId: s.menteeId } } })).toBe(0);
  expect(await prisma.personalNote.count({ where: { body: { contains: p.meetingNote } } })).toBe(0);
  expect(await prisma.personalNote.count({ where: { body: { contains: p.conversationNote } } })).toBe(0);
  expect(await prisma.personalNote.count({ where: { body: { contains: p.ownNote } } })).toBe(0);
  expect(await prisma.relationNote.count({ where: { body: { contains: p.relationNote } } })).toBe(0);
  expect(await prisma.interactionLog.count({ where: { notes: { contains: p.interactionNotes } } })).toBe(0);
  expect(await prisma.interactionLog.count({ where: { subject: { contains: p.interactionSubject } } })).toBe(0);
  expect(await prisma.mentorshipRequest.count({ where: { message: { contains: p.request } } })).toBe(0);
  expect(await prisma.user.count({ where: { reEngageNote: { contains: p.reEngage } } })).toBe(0);
  // #2106 — the rest of the sanitize-db inventory.
  expect(await prisma.evaluation.count({ where: { comment: { contains: p.evalComment } } })).toBe(0);
  expect(await prisma.evaluation.count({ where: { publicExcerpt: { contains: p.evalExcerpt } } })).toBe(0);
  expect(await prisma.weeklyReport.count({ where: { summary: { contains: p.weeklySummary } } })).toBe(0);
  expect(await prisma.weeklyReport.count({ where: { blockers: { contains: p.weeklyBlockers } } })).toBe(0);
  expect(await prisma.weeklyReport.count({ where: { mentorComment: { contains: p.weeklyMentorComment } } })).toBe(0);
  expect(await prisma.mentorQuestion.count({ where: { question: { contains: p.question } } })).toBe(0);
  expect(await prisma.mentorQuestion.count({ where: { answer: { contains: p.answer } } })).toBe(0);
  expect(await prisma.meetingRequest.count({ where: { topic: { contains: p.meetingTopic } } })).toBe(0);
  expect(await prisma.meeting.count({ where: { title: { contains: p.meetingTitle } } })).toBe(0);
  expect(await prisma.meeting.count({ where: { cancelReason: { contains: p.cancelReason } } })).toBe(0);
  expect(await prisma.goal.count({ where: { description: { contains: p.goal } } })).toBe(0);
  expect(await prisma.projectJoinRequest.count({ where: { message: { contains: p.joinMessage } } })).toBe(0);
  expect(await prisma.projectJoinRequest.count({ where: { decisionNote: { contains: p.joinDecision } } })).toBe(0);
  expect(await prisma.companyInterest.count({ where: { note: { contains: p.interestNote } } })).toBe(0);
  expect(await prisma.interviewRequest.count({ where: { note: { contains: p.interviewNote } } })).toBe(0);
  expect(await prisma.interviewRequest.count({ where: { declineNote: { contains: p.interviewDecline } } })).toBe(0);
  expect(await prisma.offer.count({ where: { compensationNote: { contains: p.offerComp } } })).toBe(0);
  expect(await prisma.offer.count({ where: { declineNote: { contains: p.offerDecline } } })).toBe(0);
  expect(await prisma.statusChange.count({ where: { reasonNote: { contains: p.statusNote } } })).toBe(0);
  expect(await prisma.notification.count({ where: { text: { contains: p.notification } } })).toBe(0);
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('anonymizing an account scrubs its messages, attachments, support thread and the notes about it', async ({
  page,
}) => {
  const s = await seedPaperTrail('erase-anon');
  try {
    await anonymizeUser(s.menteeId);

    await expectNoFreeTextLeft(s);

    // The row survives — that is the point of anonymise — but nothing on it
    // identifies anybody any more.
    const user = await prisma.user.findUnique({ where: { id: s.menteeId } });
    expect(user?.fullName).toBe('Erased candidate');
    expect(user?.city).toBeNull();
    expect(user?.country).toBeNull();
    expect(user?.referralSource).toBeNull();
    expect(user?.reEngageNote).toBeNull();

    // Written by the person → tombstoned, not deleted: the row and its
    // timestamp stay so the other side's thread keeps its shape, and
    // `deletedForEveryoneAt` is exactly what the messages API masks on.
    const messages = await prisma.message.findMany({ where: { id: { in: s.menteeMessageIds } } });
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m.body).toBe('');
      expect(m.deletedForEveryoneAt).not.toBeNull();
    }
    // The other participant's own message is none of erasure's business.
    const mentorMessage = await prisma.message.findUnique({ where: { id: s.mentorMessageId } });
    expect(mentorMessage?.body).toContain(s.tag);
    expect(mentorMessage?.deletedForEveryoneAt).toBeNull();

    // Written ABOUT the person → the free text goes, the operational record
    // (when it happened, what kind of interaction it was) stays.
    const log = await prisma.interactionLog.findUnique({ where: { id: s.interactionLogId } });
    expect(log).not.toBeNull();
    expect(log?.notes).toBe('');
    expect(log?.type).toBe('Meeting');
    expect(log?.date).toBeInstanceOf(Date);
    // Same for the mentor's meeting note: the row, its category and its dates
    // survive; the prose does not.
    const note = await prisma.personalNote.findUnique({ where: { id: s.meetingNoteId } });
    expect(note?.body).toBe('');
    expect(note?.category).toBe('MEETING');
    // #2106: the operational rows stay, with only their prose gone.
    const evaluation = await prisma.evaluation.findUnique({ where: { id: s.evaluationId } });
    expect(evaluation).not.toBeNull();
    expect(evaluation?.comment).toBeNull();
    const report = await prisma.weeklyReport.findUnique({ where: { id: s.weeklyReportId } });
    expect(report?.summary).toBe('');
    expect(report?.weekStart).toBeInstanceOf(Date);
    expect(await prisma.statusChange.count({ where: { relationId: s.relationId, toStatus: 'APPROVAL_PENDING_220' } })).toBe(1);
    // Their own bell is theirs alone, so it is gone rather than emptied.
    expect(await prisma.notification.count({ where: { userId: s.menteeId } })).toBe(0);

    // …and the conversation still renders for the other participant: the thread
    // comes back with a tombstone, not a crash and not a blank thread.
    await signInAndSettle(page, s.mentorEmail, PASSWORD, '/mentor');
    const res = await page.request.get(`/api/messages?conversationId=${s.conversationId}`);
    expect(res.ok()).toBeTruthy();
    const payload = (await res.json()) as {
      messages: { id: string; body: string; deleted: boolean; attachments: unknown[] }[];
    };
    expect(payload.messages).toHaveLength(2);
    const erased = payload.messages.find((m) => s.menteeMessageIds.includes(m.id));
    expect(erased?.deleted).toBe(true);
    expect(erased?.body).toBe('');
    expect(erased?.attachments).toEqual([]);
    expect(payload.messages.find((m) => m.id === s.mentorMessageId)?.body).toContain(s.tag);
  } finally {
    await cleanup(s);
  }
});

test('hard-deleting an account leaves none of its free text behind, including what others wrote about it', async () => {
  const s = await seedPaperTrail('erase-hard');
  try {
    await hardDeleteUser(s.menteeId);

    expect(await prisma.user.count({ where: { id: s.menteeId } })).toBe(0);
    await expectNoFreeTextLeft(s);

    // The relation cascade takes the relation-bound message, the interaction
    // log and the relation note with it. The conversation-layer message has no
    // FK to either the user or the relation, so only the explicit tombstone
    // reaches it — it is still there, and it is empty.
    const surviving = await prisma.message.findMany({ where: { conversationId: s.conversationId } });
    expect(surviving.some((m) => m.senderId === s.menteeId && m.body === '')).toBe(true);
    expect(surviving.find((m) => m.id === s.mentorMessageId)?.body).toContain(s.tag);

    // The mentor's meeting note outlives the meeting (`meetingId` is SetNull),
    // which is precisely why it has to be scrubbed BEFORE the relation goes:
    // afterwards nothing links it to the person any more.
    const note = await prisma.personalNote.findUnique({ where: { id: s.meetingNoteId } });
    expect(note?.body).toBe('');
    // Same for the note on the conversation meeting: that meeting survives the
    // user (its `relationId` is null, so no cascade touches it), and the only
    // link to the erased person — their `ConversationParticipant` row — went
    // with the user row. So this one, too, is only reachable before the delete.
    const convNote = await prisma.personalNote.findUnique({ where: { id: s.conversationNoteId } });
    expect(convNote?.body).toBe('');
  } finally {
    await cleanup(s);
  }
});

test("erasing the MENTOR takes the prose they authored, and leaves the mentee's own words alone (#2106)", async () => {
  const s = await seedPaperTrail('erase-mentor');
  try {
    await anonymizeUser(s.mentorId);

    // Their words as an author, about somebody else: gone, rows kept.
    const p = s.pii;
    expect(await prisma.evaluation.count({ where: { comment: { contains: p.evalComment } } })).toBe(0);
    expect(await prisma.evaluation.count({ where: { publicExcerpt: { contains: p.evalExcerpt } } })).toBe(0);
    expect(await prisma.mentorQuestion.count({ where: { answer: { contains: p.answer } } })).toBe(0);
    expect(await prisma.weeklyReport.count({ where: { mentorComment: { contains: p.weeklyMentorComment } } })).toBe(0);
    expect(await prisma.evaluation.count({ where: { id: s.evaluationId } })).toBe(1);

    // The mentee's own record is not the mentor's to erase.
    const report = await prisma.weeklyReport.findUnique({ where: { id: s.weeklyReportId } });
    expect(report?.summary).toBe(p.weeklySummary);
    expect(report?.blockers).toBe(p.weeklyBlockers);
    const question = await prisma.mentorQuestion.findUnique({ where: { id: s.questionId } });
    expect(question?.question).toBe(p.question);
    expect(await prisma.goal.count({ where: { description: { contains: p.goal } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: s.menteeId } })).toBe(1);
  } finally {
    await cleanup(s);
  }
});
