// Post-meeting feedback (#1896): record one participant's answer, read it
// back under the visibility rule, aggregate it for the health score, and ask
// for it — once — by e-mail when nobody answered in the app.
//
// THE VISIBILITY RULE, enforced in the queries below and nowhere else:
//   • a rater reads their OWN answer, always;
//   • a mentor reads only the AGGREGATE of the answers about their meetings,
//     and only above the response floor (src/lib/surveyPrivacy.ts) — never one
//     mentee's rating, never a note. The aggregate never includes the mentor's
//     own answers either, so it is what the other side thought;
//   • `happened = false` is counted in `happenedRate`, never in
//     `avgHelpfulness`: a meeting that did not take place is not a bad meeting.
// Rating is free for every participant — no entitlement check anywhere here.

import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { effectiveMinResponses } from '@/lib/surveyPrivacy';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { meetingFeedbackUrl, DID_NOT_MEET } from '@/lib/meetingFeedbackToken';
import { emailDictionary } from '@/i18n/emailDictionary';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { formatDateTime } from '@/lib/relativeTime';
import { emailBrand, sendEmail } from '@/services/emailService';

const DAY = 24 * 60 * 60 * 1000;

export const feedbackSchema = z
  .object({
    happened: z.boolean(),
    helpfulness: z.number().int().min(1).max(5).nullable().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export type FeedbackInput = z.infer<typeof feedbackSchema>;

/** A rater's own answer — the only individual shape any response ever carries. */
const OWN_SELECT = { id: true, meetingId: true, happened: true, helpfulness: true, note: true, updatedAt: true } as const;

export class FeedbackNotAllowed extends Error {}

/**
 * Record (or update) one rater's answer about one relation meeting. Only the
 * relation's two people may rate it; a meeting that is not a relation meeting,
 * or was called off, is not rated. A "didn't meet" answer clears helpfulness.
 */
export async function recordMeetingFeedback(meetingId: string, raterId: string, input: FeedbackInput) {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, status: true, relationId: true, relation: { select: { orgId: true, mentorId: true, menteeId: true } } },
  });
  if (!meeting?.relation || meeting.status !== 'SCHEDULED') throw new FeedbackNotAllowed('not a rateable meeting');
  if (meeting.relation.mentorId !== raterId && meeting.relation.menteeId !== raterId) throw new FeedbackNotAllowed('not a participant');

  const data = {
    happened: input.happened,
    helpfulness: input.happened ? (input.helpfulness ?? null) : null,
    ...(input.note !== undefined ? { note: input.note || null } : {}),
  };
  return prisma.meetingFeedback.upsert({
    where: { meetingId_raterId: { meetingId, raterId } },
    create: { meetingId, raterId, orgId: meeting.relation.orgId, relationId: meeting.relationId, ...data },
    update: data,
    select: OWN_SELECT,
  });
}

/** The caller's own answer for a meeting, or null. */
export async function ownMeetingFeedback(meetingId: string, raterId: string) {
  return prisma.meetingFeedback.findUnique({ where: { meetingId_raterId: { meetingId, raterId } }, select: OWN_SELECT });
}

export interface MeetingQuality {
  n: number;
  /** Mean of the 1–5 answers of meetings that happened; null when none did. */
  avgHelpfulness: number | null;
  /** Share (0–1) of answers saying the meeting took place. */
  happenedRate: number;
}

function aggregate(rows: { happened: boolean; helpfulness: number | null }[]): MeetingQuality | null {
  if (rows.length < effectiveMinResponses()) return null;
  const rated = rows.filter((r) => r.happened && r.helpfulness !== null).map((r) => r.helpfulness as number);
  return {
    n: rows.length,
    avgHelpfulness: rated.length ? Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10 : null,
    happenedRate: Math.round((rows.filter((r) => r.happened).length / rows.length) * 100) / 100,
  };
}

/**
 * The health score's sentiment input for one relation (#1898 reads it): every
 * answer about the pair's meetings in the window. Null below the response
 * floor — an average over two answers is one person's opinion with a decimal
 * point, and in a pair it is trivially attributable.
 */
export async function meetingQualityFor(relationId: string, windowDays: number, now = new Date()): Promise<MeetingQuality | null> {
  const rows = await prisma.meetingFeedback.findMany({
    where: { relationId, createdAt: { gte: new Date(now.getTime() - windowDays * DAY) } },
    select: { happened: true, helpfulness: true },
  });
  return aggregate(rows);
}

/**
 * What a mentor may see: the aggregate of the answers OTHER people gave about
 * the meetings of their relationships, above the floor. No row, no note, no
 * rater ever leaves this function.
 */
export async function mentorMeetingQuality(mentorId: string, windowDays: number, now = new Date()): Promise<MeetingQuality | null> {
  const rows = await prisma.meetingFeedback.findMany({
    where: {
      raterId: { not: mentorId },
      createdAt: { gte: new Date(now.getTime() - windowDays * DAY) },
      meeting: { relation: { mentorId } },
    },
    select: { happened: true, helpfulness: true },
  });
  return aggregate(rows);
}

/**
 * Ask the mentee of each meeting, once, how it was. Only relation meetings
 * that were not called off or declined, only an active mentee who has not
 * answered in the app already. The meeting row is CLAIMED (feedbackAskedAt)
 * before the mail goes, so a second sweep — or two overlapping ticks — finds
 * it claimed and asks nobody. External guests have no relation and are never
 * reached from here.
 */
export async function askForMeetingFeedback(meetingIds: string[]): Promise<number> {
  if (meetingIds.length === 0) return 0;
  const meetings = await prisma.meeting.findMany({
    where: { id: { in: meetingIds }, relationId: { not: null }, status: 'SCHEDULED', rsvp: { not: 'DECLINED' }, feedbackAskedAt: null },
    select: {
      id: true,
      title: true,
      scheduledAt: true,
      relation: { select: { orgId: true, mentee: { select: { id: true, email: true, fullName: true, isActive: true, preferredLanguage: true, orgId: true } } } },
      feedback: { select: { raterId: true } },
    },
  });
  let asked = 0;
  for (const m of meetings) {
    const mentee = m.relation?.mentee;
    if (!mentee || !mentee.isActive || !m.scheduledAt) continue;
    if (m.feedback.some((f) => f.raterId === mentee.id)) continue;
    const claimed = await prisma.meeting.updateMany({ where: { id: m.id, feedbackAskedAt: null }, data: { feedbackAskedAt: new Date() } });
    if (claimed.count === 0) continue;

    const locale: Locale = isLocale(mentee.preferredLanguage ?? undefined) ? (mentee.preferredLanguage as Locale) : defaultLocale;
    const org = await settingsOrgOfRow(m.relation?.orgId ?? mentee.orgId);
    const t = (await emailDictionary(locale, org)).meetingFeedback;
    const brand = await emailBrand(org);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const link = (rating: number) => meetingFeedbackUrl({ meetingId: m.id, userId: mentee.id, rating }, brand.appUrl);
    const button = (rating: number, label: string) =>
      `<a href="${esc(link(rating))}" style="display:inline-block;margin:0 4px 6px 0;padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;color:#111827;text-decoration:none;">${esc(label)}</a>`;
    const html = `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
        <h2 style="color:${esc(brand.accent)};">${esc(t.cardTitle)}</h2>
        <p>${esc(t.emailGreeting.replace('{name}', mentee.fullName))}</p>
        <p>${esc(t.emailIntro.replace('{title}', m.title).replace('{date}', formatDateTime(m.scheduledAt, locale)))}</p>
        <p style="margin:4px 0;color:#6b7280;font-size:13px;">${esc(t.helpfulness)} — 1 = ${esc(t.low)}, 5 = ${esc(t.high)}</p>
        <p>${[1, 2, 3, 4, 5].map((r) => button(r, String(r))).join('')}</p>
        <p>${button(DID_NOT_MEET, t.emailDidNotMeet)}</p>
        <p style="font-size:12px;color:#6b7280;">${esc(t.privacy)} ${esc(t.emailFooter)}</p>
      </div>`;
    await sendEmail({
      category: 'meeting-feedback',
      userId: mentee.id,
      orgId: mentee.orgId,
      locale,
      to: mentee.email,
      subject: t.emailSubject.replace('{title}', m.title),
      html,
    }).catch((error) => logger.error('Meeting feedback ask failed', { meetingId: m.id, error: String(error) }));
    asked++;
  }
  return asked;
}
