import { prisma } from '@/lib/prisma';

// Detailed mentee activity report. Aggregates, for a time window, the signals
// that answer "what has this mentee (and their mentor) been doing": login
// recency, time on site + pages visited (consent-gated PageView data), completed
// goals/todos, interactions logged, meetings, pipeline moves and messages.
//
// Used by both the in-app report pages and the daily email digest.

export interface PageStat {
  path: string;
  views: number;
  seconds: number;
}

export interface MenteeActivity {
  menteeId: string;
  menteeName: string;
  lastLoginAt: Date | null;
  daysSinceLogin: number | null;
  lastSeenAt: Date | null;
  // Consent-gated web analytics (zero when the mentee hasn't opted in).
  timeOnSiteSec: number;
  pageViews: number;
  topPages: PageStat[];
  // Domain activity in the window.
  goalsCompleted: number;
  goalsOpen: number;
  interactions: number;
  meetings: number;
  pipelineChanges: number;
  messagesSent: number;
  messagesReceived: number;
  // Convenience flag for the "inactive" highlight.
  active: boolean;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

// Build the activity summary for one mentee over [since, now].
export async function getMenteeActivity(
  mentee: { id: string; fullName: string; lastLoginAt: Date | null; lastSeenAt: Date | null },
  relationIds: string[],
  since: Date
): Promise<MenteeActivity> {
  const now = new Date();
  const relFilter = { relationId: { in: relationIds.length ? relationIds : ['__none__'] } };

  const [
    pv,
    topPagesRaw,
    goalsCompleted,
    goalsOpen,
    interactions,
    meetings,
    pipelineChanges,
    messagesSent,
    messagesReceived,
  ] = await Promise.all([
    prisma.pageView.aggregate({
      where: { userId: mentee.id, createdAt: { gte: since } },
      _sum: { durationSec: true },
      _count: true,
    }),
    prisma.pageView.groupBy({
      by: ['path'],
      where: { userId: mentee.id, createdAt: { gte: since } },
      _count: { path: true },
      _sum: { durationSec: true },
      orderBy: { _count: { path: 'desc' } },
      take: 5,
    }),
    prisma.goal.count({ where: { ...relFilter, completedAt: { gte: since } } }),
    prisma.goal.count({ where: { ...relFilter, status: 'OPEN' } }),
    prisma.interactionLog.count({ where: { ...relFilter, date: { gte: since } } }),
    prisma.meeting.count({ where: { ...relFilter, createdAt: { gte: since } } }),
    prisma.statusChange.count({ where: { ...relFilter, createdAt: { gte: since } } }),
    prisma.message.count({ where: { ...relFilter, senderId: mentee.id, createdAt: { gte: since } } }),
    prisma.message.count({ where: { ...relFilter, senderId: { not: mentee.id }, createdAt: { gte: since } } }),
  ]);

  const topPages: PageStat[] = topPagesRaw.map((r) => ({
    path: r.path,
    views: r._count.path,
    seconds: r._sum.durationSec ?? 0,
  }));

  const timeOnSiteSec = pv._sum.durationSec ?? 0;
  const pageViews = pv._count;
  const domainActivity = goalsCompleted + interactions + meetings + pipelineChanges + messagesSent;

  return {
    menteeId: mentee.id,
    menteeName: mentee.fullName,
    lastLoginAt: mentee.lastLoginAt,
    daysSinceLogin: mentee.lastLoginAt ? daysBetween(mentee.lastLoginAt, now) : null,
    lastSeenAt: mentee.lastSeenAt,
    timeOnSiteSec,
    pageViews,
    topPages,
    goalsCompleted,
    goalsOpen,
    interactions,
    meetings,
    pipelineChanges,
    messagesSent,
    messagesReceived,
    active: pageViews > 0 || domainActivity > 0,
  };
}

// All mentees a given mentor is responsible for (active relations), each with
// their activity summary — the mentor's daily report.
export async function getMentorMenteeActivity(mentorId: string, since: Date): Promise<MenteeActivity[]> {
  const relations = await prisma.mentorshipRelation.findMany({
    where: { mentorId },
    select: {
      id: true,
      menteeId: true,
      mentee: { select: { id: true, fullName: true, lastLoginAt: true, lastSeenAt: true } },
    },
  });
  return buildForRelations(relations, since);
}

// System-wide: every mentee that is part of at least one relation — the admin's
// daily report.
export async function getSystemMenteeActivity(since: Date): Promise<MenteeActivity[]> {
  const relations = await prisma.mentorshipRelation.findMany({
    select: {
      id: true,
      menteeId: true,
      mentee: { select: { id: true, fullName: true, lastLoginAt: true, lastSeenAt: true } },
    },
  });
  return buildForRelations(relations, since);
}

// Group relations by mentee (a mentee may have more than one), then summarize.
async function buildForRelations(
  relations: { id: string; menteeId: string; mentee: { id: string; fullName: string; lastLoginAt: Date | null; lastSeenAt: Date | null } | null }[],
  since: Date
): Promise<MenteeActivity[]> {
  const byMentee = new Map<string, { mentee: NonNullable<(typeof relations)[number]['mentee']>; relationIds: string[] }>();
  for (const r of relations) {
    if (!r.mentee) continue;
    const entry = byMentee.get(r.menteeId) ?? { mentee: r.mentee, relationIds: [] };
    entry.relationIds.push(r.id);
    byMentee.set(r.menteeId, entry);
  }
  const results = await Promise.all(
    [...byMentee.values()].map((e) => getMenteeActivity(e.mentee, e.relationIds, since))
  );
  // Most active first; ties broken by name for stable ordering.
  return results.sort((a, b) => {
    const aScore = a.pageViews + a.goalsCompleted + a.interactions + a.meetings + a.messagesSent;
    const bScore = b.pageViews + b.goalsCompleted + b.interactions + b.meetings + b.messagesSent;
    if (bScore !== aScore) return bScore - aScore;
    return a.menteeName.localeCompare(b.menteeName);
  });
}

// "1h 23m" / "5m" / "0m" — compact time-on-site formatting for UI + email.
export function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
