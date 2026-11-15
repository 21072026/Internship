// The sales rep's calendar items (#3778): what is on THEIR book in a window.
// Server-only (Prisma). One loader, two readers: GET /api/sales/calendar (the
// calendar page) and the "Today" card on /sales — so the card can never list a
// follow-up or a meeting the calendar would not, or the other way round.
//
//   meeting  — a scheduled meeting on one of their records;
//   followup — a record's follow-up day (`nextActionAt`, #2563), overdue by the
//              one rule the panel, the reminder and the queue share;
//   trial    — a running trial's end day (`trialEndsAt`, #2553).
//
// The scope is the caller's own records inside their own org: `orgId` AND
// `mentorId` are written into every query here, never left to the tenant
// middleware. Who may call it at all is the caller's business (salesPoolGate
// for the API, the sales shell + hasSalesSurface for the page).
import { prisma } from '@/lib/prisma';
import { isNextActionOverdue } from '@/lib/nextActionRule';
import { salesLeadHref } from '@/lib/salesSurface';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Per kind, so a crowded book cannot turn one read into a scan. */
const MAX_PER_KIND = 500;

/** The UTC calendar day a date-only column stands for, as `YYYY-MM-DD`. */
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export type SalesCalendarEvent =
  | {
      id: string;
      type: 'meeting';
      title: string;
      who: string;
      date: string;
      durationMinutes: number | null;
      link: string;
      relationId: string;
    }
  | {
      id: string;
      type: 'followup';
      /** The follow-up's own step — the owner's note. Owner-only by construction: this loader reads own records only. */
      title: string;
      who: string;
      /** `YYYY-MM-DD`, the UTC day stored. */
      date: string;
      allDay: true;
      overdue: boolean;
      link: string;
      relationId: string;
    }
  | {
      id: string;
      type: 'trial';
      title: '';
      who: string;
      date: string;
      allDay: true;
      link: string;
      relationId: string;
    };

export async function loadSalesCalendar(opts: {
  orgId: string;
  userId: string;
  /** Meetings and trial ends from this instant… */
  from: Date;
  /** …to this one. */
  to: Date;
  /**
   * Follow-ups from this instant instead of `from` — the Today card asks for
   * every overdue one, however old, in the same read.
   */
  followUpsFrom?: Date;
  now?: number;
}): Promise<SalesCalendarEvent[]> {
  const { orgId, userId, from, to } = opts;
  const now = opts.now ?? Date.now();
  // Date-only columns are stored at UTC midnight: widen by a day on each side so
  // a day at the edge of the viewer's local range is not lost to the offset.
  const dayFrom = new Date((opts.followUpsFrom ?? from).getTime() - DAY_MS);
  const trialFrom = new Date(from.getTime() - DAY_MS);
  const dayTo = new Date(to.getTime() + DAY_MS);
  const lead = { mentee: { select: { fullName: true } } } as const;

  const [meetings, followUps, trials] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        seriesId: null,
        status: 'SCHEDULED',
        scheduledAt: { gte: from, lte: to },
        relation: { is: { orgId, mentorId: userId } },
      },
      select: { id: true, title: true, scheduledAt: true, durationMinutes: true, relationId: true, relation: { select: lead } },
      orderBy: { scheduledAt: 'asc' },
      take: MAX_PER_KIND,
    }),
    prisma.mentorshipRelation.findMany({
      where: { orgId, mentorId: userId, status: 'ACTIVE', nextActionAt: { gte: dayFrom, lte: dayTo } },
      select: { id: true, nextActionAt: true, nextActionNote: true, ...lead },
      orderBy: { nextActionAt: 'asc' },
      take: MAX_PER_KIND,
    }),
    prisma.mentorshipRelation.findMany({
      where: { orgId, mentorId: userId, status: 'ACTIVE', trialEndsAt: { gte: trialFrom, lte: dayTo } },
      select: { id: true, trialEndsAt: true, ...lead },
      orderBy: { trialEndsAt: 'asc' },
      take: MAX_PER_KIND,
    }),
  ]);

  const events: SalesCalendarEvent[] = [
    ...meetings
      .filter((m) => m.scheduledAt && m.relationId && m.relation)
      .map((m) => ({
        id: `meeting-${m.id}`,
        type: 'meeting' as const,
        title: m.title,
        who: m.relation!.mentee.fullName,
        date: m.scheduledAt!.toISOString(),
        durationMinutes: m.durationMinutes ?? null,
        link: salesLeadHref(m.relationId!),
        relationId: m.relationId!,
      })),
    ...followUps.map((r) => ({
      id: `followup-${r.id}`,
      type: 'followup' as const,
      title: r.nextActionNote ?? '',
      who: r.mentee.fullName,
      date: utcDay(r.nextActionAt!),
      allDay: true as const,
      overdue: isNextActionOverdue(r.nextActionAt!, now),
      link: salesLeadHref(r.id),
      relationId: r.id,
    })),
    ...trials.map((r) => ({
      id: `trial-${r.id}`,
      type: 'trial' as const,
      title: '' as const,
      who: r.mentee.fullName,
      date: utcDay(r.trialEndsAt!),
      allDay: true as const,
      link: salesLeadHref(r.id),
      relationId: r.id,
    })),
  ];
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
