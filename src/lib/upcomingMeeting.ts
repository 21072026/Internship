import { prisma } from '@/lib/prisma';
import { parseDaysOfWeek, seriesOccurrences } from '@/lib/meetingSeriesOccurrences';

// "There is a meeting about to start / happening right now" (#51 follow-up).
//
// Two things can put a meeting on someone's calendar here, and the answer has to
// cover both:
//   1. a `Meeting` row — a one-off, or an occurrence generated from a series,
//      tied to a MentorshipRelation (so: its mentor and its mentee), or since
//      #1051 to a project or a conversation (so: its members / participants);
//   2. a `MeetingSeries` rule on a project — the recurring project call, which
//      every project member is expected at whether or not they have a relation
//      carrying that project.
//
// A meeting has no end time in the schema, so "still going" is a fixed window
// after the start (MEETING_DURATION_MINUTES).

/** How long a meeting is assumed to run — the join link stays offered this long. */
export const MEETING_DURATION_MINUTES = 60;
/** How early the dashboard starts announcing the next meeting. */
export const MEETING_LEAD_MINUTES = 30;

export interface UpcomingMeeting {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  meetLink: string | null;
  /** True while the meeting is in its assumed duration window. */
  ongoing: boolean;
  /** Whole minutes until it starts; 0 once it has started. */
  minutesUntilStart: number;
  projectId: string | null;
  projectName: string | null;
}

interface Candidate {
  id: string;
  title: string;
  startsAt: Date;
  meetLink: string | null;
  projectId: string | null;
  projectName: string | null;
}

/**
 * The meeting to surface for this user: the one in progress if there is one,
 * otherwise the next one starting within the lead time. Null when neither.
 */
export async function getUpcomingMeeting(userId: string, now = new Date()): Promise<UpcomingMeeting | null> {
  if (!userId) return null;

  const windowStart = new Date(now.getTime() - MEETING_DURATION_MINUTES * 60 * 1000);
  const windowEnd = new Date(now.getTime() + MEETING_LEAD_MINUTES * 60 * 1000);

  const [meetings, memberships, relationProjects] = await Promise.all([
    prisma.meeting.findMany({
      where: {
        scheduledAt: { gte: windowStart, lte: windowEnd },
        // A Meeting row hangs off a relation, a project or a conversation (#1051);
        // whichever it is, the user is expected there if they are on that side of it.
        OR: [
          { relation: { OR: [{ mentorId: userId }, { menteeId: userId }] } },
          { project: { members: { some: { userId } } } },
          { conversation: { participants: { some: { userId } } } },
        ],
      },
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        meetLink: true,
        projectId: true,
        project: { select: { name: true } },
        relation: { select: { projectId: true, project: { select: { name: true } } } },
      },
    }),
    prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } }),
    prisma.mentorshipRelation.findMany({
      where: { OR: [{ mentorId: userId }, { menteeId: userId }], status: 'ACTIVE', projectId: { not: null } },
      select: { projectId: true },
    }),
  ]);

  const candidates: Candidate[] = meetings
    .filter((m) => m.scheduledAt)
    .map((m) => ({
      id: m.id,
      title: m.title,
      startsAt: m.scheduledAt!,
      meetLink: m.meetLink,
      projectId: m.projectId ?? m.relation?.projectId ?? null,
      projectName: m.project?.name ?? m.relation?.project?.name ?? null,
    }));

  const projectIds = [
    ...new Set([
      ...memberships.map((m) => m.projectId),
      ...relationProjects.map((r) => r.projectId!).filter(Boolean),
    ]),
  ];

  if (projectIds.length > 0) {
    const series = await prisma.meetingSeries.findMany({
      where: { active: true, projectId: { in: projectIds } },
      select: {
        id: true,
        title: true,
        daysOfWeek: true,
        timeOfDay: true,
        timeZone: true,
        fixedLink: true,
        projectId: true,
        project: { select: { name: true } },
      },
    });
    for (const s of series) {
      if (parseDaysOfWeek(s.daysOfWeek).length === 0) continue;
      for (const when of seriesOccurrences(s.daysOfWeek, s.timeOfDay, windowStart, windowEnd, s.timeZone)) {
        candidates.push({
          id: `${s.id}:${when.toISOString()}`,
          title: s.title,
          startsAt: when,
          meetLink: s.fixedLink,
          projectId: s.projectId,
          projectName: s.project?.name ?? null,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  // A series occurrence and the Meeting row generated from it are the same event;
  // the Meeting row was pushed first, so keep that one.
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.startsAt.toISOString()}|${c.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ongoing = unique
    .filter((c) => c.startsAt <= now)
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  const upcoming = unique
    .filter((c) => c.startsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  // In progress wins over "starts in 20 minutes": it is the one you are late for.
  const pick = ongoing[0] ?? upcoming[0];
  if (!pick) return null;

  const startsAt = pick.startsAt;
  const endsAt = new Date(startsAt.getTime() + MEETING_DURATION_MINUTES * 60 * 1000);
  return {
    id: pick.id,
    title: pick.title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    meetLink: pick.meetLink,
    ongoing: startsAt <= now,
    minutesUntilStart: Math.max(0, Math.ceil((startsAt.getTime() - now.getTime()) / 60000)),
    projectId: pick.projectId,
    projectName: pick.projectName,
  };
}
