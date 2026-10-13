import { z } from 'zod';
import type { Prisma } from '@prisma/client';

export const INTERVIEW_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'DECLINED', 'SCHEDULED', 'CANCELLED'] as const;

export const createInterviewRequestSchema = z.object({
  requisitionId: z.string().min(1),
  menteeId: z.string().min(1),
  note: z.string().trim().max(1000).nullable().optional(),
  proposedSlots: z.array(z.string().datetime({ offset: true })).max(5).optional(),
}).strict();

export const decideInterviewRequestSchema = z.object({
  action: z.enum(['approve', 'decline']),
  declineReasonCode: z.string().trim().max(64).optional(),
  declineNote: z.string().trim().max(1000).nullable().optional(),
}).strict();

export function interviewActiveKey(requisitionId: string, menteeId: string) {
  return `${requisitionId}:${menteeId}`;
}

// ── Scheduling (#1844) ───────────────────────────────────────────────────────

/** The statuses an approver may still act on: schedule from APPROVED, cancel from either. */
export const CANCELLABLE_INTERVIEW_STATUSES = ['APPROVED', 'SCHEDULED'] as const;

export const MAX_INTERVIEW_GUESTS = 5;

export const scheduleInterviewRequestSchema = z.object({
  /** The confirmed instant, zone-qualified. One of the proposed slots unless `override` is set. */
  slot: z.string().datetime({ offset: true }),
  /** The IANA zone the approver picked the slot on — stored on the Meeting, named in every mail. */
  timeZone: z.string().trim().min(1).max(80),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  meetLink: z.string().trim().max(500).optional(),
  /** The company's interviewers: addresses, not accounts. Each becomes a MeetingGuest. */
  guestEmails: z.array(z.string().trim().toLowerCase().email().max(200)).max(MAX_INTERVIEW_GUESTS).optional(),
  /** "Another time": the slot is not one the company proposed, and the approver says so. */
  override: z.boolean().optional(),
  /** Convene the scorecard panel in the same transaction (#1846): its scheduledAt is the meeting's. */
  createPanel: z.boolean().optional(),
  /** The internal interviewers (ADMIN/MENTOR accounts) who sit on that panel. */
  interviewerIds: z.array(z.string().min(1)).max(10).optional(),
}).strict();

export const cancelInterviewRequestSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
}).strict();

/**
 * Is `slot` one of the company's proposed slots? Compared as instants, so the
 * same moment written with another offset still counts; an unreadable entry
 * in the stored list never matches anything.
 */
export function isProposedSlot(proposedSlots: unknown, slot: string): boolean {
  if (!Array.isArray(proposedSlots)) return false;
  const wanted = new Date(slot).getTime();
  if (Number.isNaN(wanted)) return false;
  return proposedSlots.some((entry) => typeof entry === 'string' && new Date(entry).getTime() === wanted);
}

/**
 * Who may decide, schedule or cancel an interview request — as the Prisma
 * filter the route loads the row through, so "not yours" is a 404 everywhere
 * (never a 403 that confirms the id). ADMIN: the org. MENTOR: requests for
 * mentees they actively mentor. COMPANY (cancel only, decided by the route):
 * its own requests. Anything else sees nothing.
 */
export function interviewRequestActorWhere(actor: {
  role: string;
  userId: string;
  orgId: string;
  companyId?: string | null;
}): Prisma.InterviewRequestWhereInput | null {
  switch (actor.role) {
    case 'ADMIN':
      return { orgId: actor.orgId };
    case 'MENTOR':
      return { orgId: actor.orgId, mentee: { menteeRelations: { some: { mentorId: actor.userId, status: 'ACTIVE', orgId: actor.orgId } } } };
    case 'COMPANY':
      return actor.companyId ? { orgId: actor.orgId, companyId: actor.companyId } : null;
    default:
      return null;
  }
}

/** The BCP 47 tag a stored preferredLanguage renders dates in (#1422). */
export function intlLocaleFor(preferredLanguage: string | null | undefined): string {
  switch (preferredLanguage) {
    case 'tr':
      return 'tr-TR';
    case 'de':
      return 'de-DE';
    default:
      return 'en-GB';
  }
}
