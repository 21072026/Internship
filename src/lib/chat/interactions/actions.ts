import { prisma } from '@/lib/prisma';
import { getDictionary } from '@/i18n/dictionaries';
import { formatInTimeZone } from '@/lib/timezone';
import { intlLocaleFor } from '@/lib/interviewRequests';
import { interpolate } from '@/lib/notificationText';
import { registerChatAction, type ChatActor } from './dispatch';
import type { Session } from 'next-auth';
import { appOriginForOrg } from '@/lib/orgLinkOrigin';
import { suggestedTimesFor } from '@/lib/suggestedTimesFor';
import { createMeetingRequest } from '@/lib/meetingRequestCreate';
import { decideMeetingRequest } from '@/lib/meetingRequestDecision';
import { recordMeetingRsvp } from '@/lib/meetingRsvp';
import { decideInterviewRequest } from '@/lib/interviewRequestDecision';
import { INTERVIEW_DECLINE_REASON_CODES, isInterviewDeclineReasonCode } from '@/lib/interviewDeclineReasons';
import { submitSurveyResponse, SurveyAnswerInvalid, SurveyConflict, surveyAcceptsAnswers } from '@/lib/surveys';
import { mintInvitationReminderToken, surveyInviteUrl } from '@/lib/surveyTokens';
import { pickLocalized } from '@/lib/surveySchema';
import { answerableInChat, choicesFor, decodeState, encodeState, type FlowState } from '@/lib/chat/surveyFlow';

// The built-in chat actions (#1948). Each one is something the person could
// do in the app, asking the same rule the app asks.

/**
 * `meetings.upcoming` — "my next meetings": the clicking person's own next
 * three scheduled meetings, in THEIR zone and language. Read-only, so a
 * platform retry is harmless. Scoped exactly like the mentor's and mentee's
 * GET /api/meetings: meetings of a relation the person is a side of, in their
 * own org. An admin has no such relation and gets the empty answer — this is
 * "mine", not the org's calendar.
 */
registerChatAction('meetings.upcoming', async ({ user }) => {
  const t = getDictionary(user.locale).chatInteraction;
  const rows = await prisma.meeting.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledAt: { gte: new Date() },
      relation: { is: { orgId: user.orgId, OR: [{ mentorId: user.id }, { menteeId: user.id }] } },
    },
    select: { title: true, scheduledAt: true },
    orderBy: { scheduledAt: 'asc' },
    take: 3,
  });
  // A mentee with an active pair is offered the next step right there (#1951).
  const relationId = await activeRelationOf(user);
  const buttons = relationId ? [{ label: getDictionary(user.locale).chatCard.book, actionId: 'meeting.book', value: relationId }] : undefined;
  if (rows.length === 0) return { text: t.upcomingNone, buttons };
  const lines = rows.map(
    (m) => `• ${interpolate(t.upcomingLine, { title: m.title, when: formatInTimeZone(m.scheduledAt!, user.timeZone, undefined, intlLocaleFor(user.locale)) })}`,
  );
  return { text: `${t.upcomingHeader}\n${lines.join('\n')}`, buttons };
});

// ── Booking from chat (#1951) ───────────────────────────────────────────────
//
// Decided on the issue: a pick in chat opens a MeetingRequest — exactly what
// the mentee's "request a meeting" does in the app — and the mentor answers it
// in the app or on the card. Nothing here writes a Meeting or a request
// itself: the three handlers call the SAME services the app's routes call
// (suggestedTimesFor, createMeetingRequest, decideMeetingRequest), with a
// session-shaped view of the person the dispatcher verified. So who may book
// where, the conflict and booking-rule checks, the lock-check-write on accept
// and the mails are the app's, not a copy.

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The verified person as the shared services expect a caller: a Session-shaped
 * object built from the database row the dispatcher resolved — never a
 * sign-in, never a token. authz reads the actor live from the database anyway.
 */
async function sessionFor(user: ChatActor): Promise<Session> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { fullName: true, email: true, companyId: true, adminLevel: true },
  });
  return {
    user: { id: user.id, role: user.role, orgId: user.orgId, name: u.fullName, email: u.email, companyId: u.companyId, adminLevel: u.adminLevel },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

/** The mentee's own active relation in their org — the pair a "book" without a value means. */
async function activeRelationOf(user: ChatActor): Promise<string | null> {
  if (user.role !== 'MENTEE') return null;
  const rel = await prisma.mentorshipRelation.findFirst({
    where: { menteeId: user.id, status: 'ACTIVE', orgId: user.orgId },
    select: { id: true },
    orderBy: { startDate: 'desc' },
  });
  return rel?.id ?? null;
}

const whenFor = (user: ChatActor, at: Date) => formatInTimeZone(at, user.timeZone, undefined, intlLocaleFor(user.locale));

/**
 * `meeting.book` — the next three times that work for both people (the app's
 * suggested-times answer: the mentor's posted hours minus everybody's busy
 * windows, within the booking rules), on the CLICKER's clock, as buttons.
 * Read-only, so a rerun is harmless.
 */
registerChatAction('meeting.book', async ({ user, value }) => {
  const t = getDictionary(user.locale).chatInteraction;
  const relationId = value && SAFE_ID.test(value) ? value : await activeRelationOf(user);
  if (!relationId) return { text: t.unavailable };
  const res = await suggestedTimesFor(await sessionFor(user), { relationId, count: 3 });
  if (!res.ok) return { text: t.unavailable };
  const body = (await res.json()) as { suggestions?: { startISO: string }[] };
  const suggestions = body.suggestions ?? [];
  if (suggestions.length === 0) return { text: `${t.bookNone}\n${await appOriginForOrg(user.orgId)}/portal` };
  return {
    text: t.bookHeader,
    buttons: suggestions.slice(0, 3).map((s) => ({
      label: whenFor(user, new Date(s.startISO)),
      actionId: 'meeting.book.pick',
      value: `${relationId}|${s.startISO}`,
    })),
  };
});

/**
 * `meeting.book.pick` — a MeetingRequest at the picked time, through the
 * app's createMeetingRequest() (thread check, archive refusal, conflict and
 * booking rules, the mentor's bell + mail + card). A second click on the same
 * time finds the request it already opened instead of opening another, so a
 * double click or a rerun is harmless.
 */
registerChatAction('meeting.book.pick', async ({ user, value }) => {
  const t = getDictionary(user.locale).chatInteraction;
  const [relationId, iso] = (value ?? '').split('|');
  const at = new Date(iso ?? '');
  if (!relationId || !SAFE_ID.test(relationId) || Number.isNaN(at.getTime())) return { text: t.unavailable };
  const requested = { text: interpolate(t.bookRequested, { when: whenFor(user, at) }), replaceOriginal: true };
  const open = await prisma.meetingRequest.findFirst({
    where: { relationId, requestedById: user.id, proposedAt: at, status: 'PENDING' },
    select: { id: true },
  });
  if (open) return requested;
  const res = await createMeetingRequest(await sessionFor(user), { relationId, topic: t.bookTopic, proposedAt: at.toISOString() });
  if (res.status === 201) return requested;
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  if (res.status === 409 && (body.code === 'conflict' || body.code === 'policy')) return { text: t.bookTaken };
  return { text: t.unavailable };
});

/**
 * `meeting_request.accept` / `.decline` — the mentor's answer on the card,
 * through the app's decideMeetingRequest(): only the pair's mentor (or an
 * admin of the org) may answer, accepting books the meeting under the same
 * lock-check-write and booking rules, and a request answered once refuses a
 * second answer — so a rerun is harmless.
 */
for (const action of ['accept', 'decline'] as const) {
  registerChatAction(`meeting_request.${action}`, async ({ user, value }) => {
    const t = getDictionary(user.locale).chatInteraction;
    if (!value || !SAFE_ID.test(value)) return { text: t.unavailable };
    const res = await decideMeetingRequest(await sessionFor(user), value, { action });
    if (res.ok) return { text: action === 'accept' ? t.requestAccepted : t.requestDeclined, replaceOriginal: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.status === 409 && body.error === 'Already handled') return { text: t.requestHandled, replaceOriginal: true };
    if (res.status === 409 && (body.code === 'conflict' || body.code === 'policy')) return { text: t.requestTaken };
    return { text: t.unavailable };
  });
}

// ── Answering on the card (#1949) ────────────────────────────────────────────
//
// Two flows that already exist and are already authorized; these handlers are
// wiring only. Each calls the SAME function its web route calls —
// recordMeetingRsvp() for the token page's yes/no, decideInterviewRequest()
// for the mentor's decision — as the person the dispatcher verified, and
// answers by REPLACING the card it was clicked on, so a decided card offers
// nothing to press again.

/**
 * `meeting.rsvp.yes` / `.no` — the invitee's answer. The invitee is the one
 * the row was written for (the mentee of its relation, the same person whose
 * mail carries the row's RSVP token); anyone else gets the neutral "no longer
 * available". A meeting that was called off or has ended takes no answer.
 * recordMeetingRsvp() is guarded on the answer changing, so a second click
 * writes nothing and tells the organiser nothing twice.
 */
for (const answer of ['yes', 'no'] as const) {
  registerChatAction(`meeting.rsvp.${answer}`, async ({ user, value }) => {
    const t = getDictionary(user.locale).chatInteraction;
    if (!value || !SAFE_ID.test(value)) return { text: t.unavailable };
    const meeting = await prisma.meeting.findFirst({
      where: { id: value, relation: { is: { menteeId: user.id } } },
      select: { id: true, title: true, createdById: true, projectId: true, conversationId: true, status: true, endedAt: true, relation: { select: { menteeId: true } } },
    });
    if (!meeting) return { text: t.unavailable };
    if (meeting.status !== 'SCHEDULED' || meeting.endedAt) return { text: t.rsvpClosed, replaceOriginal: true };
    await recordMeetingRsvp(meeting, answer === 'yes' ? 'ACCEPTED' : 'DECLINED');
    return { text: answer === 'yes' ? t.rsvpYesDone : t.rsvpNoDone, replaceOriginal: true };
  });
}

/** What decideInterviewRequest() answered, as the clicker reads it. */
async function interviewOutcome(res: Response, done: string, t: ReturnType<typeof getDictionary>['chatInteraction']) {
  if (res.ok) return { text: done, replaceOriginal: true };
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  if (res.status === 409 && body.code === 'already_decided') return { text: t.interviewHandled, replaceOriginal: true };
  // A permission or tenant refusal is neutral — it never says why.
  return { text: t.unavailable };
}

/**
 * `interview_request.approve` — through decideInterviewRequest(): only the
 * mentee's active mentor (or an admin of the org) may decide, the write is
 * guarded on PENDING, and a decided request answers "already decided".
 */
registerChatAction('interview_request.approve', async ({ user, value }) => {
  const t = getDictionary(user.locale).chatInteraction;
  if (!value || !SAFE_ID.test(value)) return { text: t.unavailable };
  const res = await decideInterviewRequest(await sessionFor(user), value, { action: 'approve' });
  return interviewOutcome(res, t.interviewApproved, t);
});

/**
 * `interview_request.decline` — a decline needs a reason (the company sees
 * it), so the first click answers with the reasons as buttons; nothing is
 * written until one is picked (`interview_request.decline.reason`).
 */
registerChatAction('interview_request.decline', async ({ user, value }) => {
  const dict = getDictionary(user.locale);
  if (!value || !SAFE_ID.test(value)) return { text: dict.chatInteraction.unavailable };
  return {
    text: dict.chatInteraction.interviewPickReason,
    buttons: INTERVIEW_DECLINE_REASON_CODES.map((code) => ({
      label: dict.interviewDeclineReasons[code],
      actionId: 'interview_request.decline.reason',
      value: `${value}|${code}`,
    })),
  };
});

registerChatAction('interview_request.decline.reason', async ({ user, value }) => {
  const t = getDictionary(user.locale).chatInteraction;
  const [id, code] = (value ?? '').split('|');
  if (!id || !SAFE_ID.test(id) || !code || !isInterviewDeclineReasonCode(code)) return { text: t.unavailable };
  const res = await decideInterviewRequest(await sessionFor(user), id, { action: 'decline', declineReasonCode: code });
  return interviewOutcome(res, t.interviewDeclined, t);
});

// ── Check-ins in chat (#1953) ────────────────────────────────────────────────
//
// A survey campaign's invitation, answered one button at a time. The answers
// so far ride in the next button's value (src/lib/chat/surveyFlow.ts), and
// nothing is written until the last click hands the whole response to the
// engine's own submitSurveyResponse() — the same call /s/[token] makes, with
// the same validation, the same single-use claim on the invitation, and the
// same anonymity rule: an ANONYMOUS survey stores neither the invitation nor
// the respondent, so the answer cannot be joined back to the chat member.
//
// Only the invitation's own person may answer it here (`userId` must match the
// verified clicker); anyone else gets the neutral "no longer available". A
// survey with a question a button cannot answer sends the person to the page.

const INVITATION_FOR_CHAT = {
  id: true,
  respondedAt: true,
  expiresAt: true,
  survey: {
    select: {
      id: true,
      status: true,
      opensAt: true,
      closesAt: true,
      questions: { orderBy: { sortOrder: 'asc' as const }, select: { key: true, type: true, required: true, labels: true, options: true } },
    },
  },
};

async function ownInvitation(user: ChatActor, invitationId: string) {
  return prisma.surveyInvitation.findFirst({ where: { id: invitationId, userId: user.id }, select: INVITATION_FOR_CHAT });
}

type ChatInvitation = NonNullable<Awaited<ReturnType<typeof ownInvitation>>>;

/** The reply for an invitation that can no longer be answered here, or null when it can. */
async function surveyRefusal(user: ChatActor, inv: ChatInvitation) {
  const t = getDictionary(user.locale).chatInteraction;
  if (inv.respondedAt) return { text: t.surveyAnswered, replaceOriginal: true };
  if (inv.expiresAt <= new Date() || !surveyAcceptsAnswers(inv.survey)) return { text: t.surveyClosed, replaceOriginal: true };
  if (!answerableInChat(inv.survey.questions)) {
    // A fresh link of the invitation's own, the way a reminder gets one.
    const token = await mintInvitationReminderToken(inv.id);
    return { text: `${t.surveyInApp}\n${surveyInviteUrl(token, await appOriginForOrg(user.orgId))}` };
  }
  return null;
}

function askQuestion(user: ChatActor, inv: ChatInvitation, state: FlowState) {
  const t = getDictionary(user.locale).chatInteraction;
  const questions = inv.survey.questions;
  const q = questions[state.next];
  const buttons = choicesFor(q, user.locale, { yes: t.surveyYes, no: t.surveyNo }).map((c) => ({
    label: c.label,
    actionId: 'survey.answer',
    value: encodeState({ invitationId: inv.id, next: state.next + 1, answers: { ...state.answers, [q.key]: c.value } }),
  }));
  if (!q.required) buttons.push({ label: t.surveySkip, actionId: 'survey.answer', value: encodeState({ ...state, next: state.next + 1 }) });
  return {
    text: interpolate(t.surveyQuestion, { n: String(state.next + 1), total: String(questions.length), question: pickLocalized(q.labels, user.locale) }),
    buttons,
    replaceOriginal: true,
  };
}

/** `survey.start` — the first question, or why there is none. Read-only, so a rerun is harmless. */
registerChatAction('survey.start', async ({ user, value }) => {
  const t = getDictionary(user.locale).chatInteraction;
  if (!value || !SAFE_ID.test(value)) return { text: t.unavailable };
  const inv = await ownInvitation(user, value);
  if (!inv) return { text: t.unavailable };
  return (await surveyRefusal(user, inv)) ?? askQuestion(user, inv, { invitationId: inv.id, next: 0, answers: {} });
});

/**
 * `survey.answer` — the next question, or, after the last one, the whole
 * response through submitSurveyResponse(). The engine claims the invitation
 * (respondedAt) in the same transaction, so a second submit is "already
 * answered" and a reminder that was due no longer goes out.
 */
registerChatAction('survey.answer', async ({ user, value }) => {
  const t = getDictionary(user.locale).chatInteraction;
  const state = decodeState(value);
  if (!state) return { text: t.unavailable };
  const inv = await ownInvitation(user, state.invitationId);
  if (!inv) return { text: t.unavailable };
  const refused = await surveyRefusal(user, inv);
  if (refused) return refused;
  if (state.next < inv.survey.questions.length) return askQuestion(user, inv, state);
  try {
    await submitSurveyResponse({ surveyId: inv.survey.id, invitationId: inv.id, respondentId: user.id, respondentRole: user.role, answers: state.answers });
    return { text: t.surveyThanks, replaceOriginal: true };
  } catch (error) {
    if (error instanceof SurveyAnswerInvalid) return { text: t.surveyRestart };
    if (error instanceof SurveyConflict) return { text: error.code === 'already_responded' ? t.surveyAnswered : t.surveyClosed, replaceOriginal: true };
    throw error;
  }
});
