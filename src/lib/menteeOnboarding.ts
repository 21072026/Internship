import { prisma } from '@/lib/prisma';

// Mentor-side onboarding wizard (#51).
//
// When a mentee joins the site or one of a mentor's projects there is a first
// week of work that always looks the same: say hello, book the kick-off call,
// hand over the starter goals, get them into the project and its group chat, and
// move them off the first pipeline stage. That was tribal knowledge; this turns
// it into a checklist the mentor can follow.
//
// Most steps can be *observed* rather than asked about — a message exists, a
// meeting exists, goals are assigned — so the checklist derives what it can and
// only falls back to a stored tick (MenteeOnboarding.steps) for the rest. A
// stored tick always wins, so a mentor can mark something done that happened
// outside the app.

export const ONBOARDING_STEPS = [
  'welcomeMessage',
  'kickoffMeeting',
  'projectAndChat',
  'goals',
  'pipeline',
  'profileReview',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** The stage every relation starts on; moving off it is the "pipeline" step. */
const FIRST_STAGE = 'APPLICATION_100';

export interface OnboardingState {
  menteeId: string;
  menteeName: string;
  relationId: string | null;
  projectId: string | null;
  startedAt: string | null;
  dismissedAt: string | null;
  /** step → done, with `auto` telling the UI it was observed, not ticked. */
  steps: Record<OnboardingStep, { done: boolean; auto: boolean }>;
  remaining: number;
}

function readStoredSteps(value: unknown): Partial<Record<OnboardingStep, boolean>> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<Record<OnboardingStep, boolean>> = {};
  for (const step of ONBOARDING_STEPS) if (raw[step] === true) out[step] = true;
  return out;
}

/**
 * Build the checklist for one mentor ↔ mentee pair. Returns null when the two
 * are not connected at all (no mentorship and no shared project), which is the
 * authorization rule for the wizard.
 */
export async function loadOnboardingState(mentorId: string, menteeId: string): Promise<OnboardingState | null> {
  const mentee = await prisma.user.findUnique({
    where: { id: menteeId },
    select: { id: true, fullName: true, role: true, cvUrl: true, university: true, bio: true },
  });
  if (!mentee || mentee.role !== 'MENTEE') return null;

  const [relation, sharedProject, record] = await Promise.all([
    prisma.mentorshipRelation.findFirst({
      where: { mentorId, menteeId },
      orderBy: { startDate: 'desc' },
      select: { id: true, startDate: true, pipelineStatus: true, projectId: true },
    }),
    prisma.projectMember.findFirst({
      where: { userId: menteeId, project: { members: { some: { userId: mentorId } } } },
      select: { projectId: true },
    }),
    prisma.menteeOnboarding.findUnique({
      where: { mentorId_menteeId: { mentorId, menteeId } },
      select: { steps: true, dismissedAt: true, projectId: true },
    }),
  ]);
  if (!relation && !sharedProject) return null;

  const projectId = sharedProject?.projectId ?? relation?.projectId ?? record?.projectId ?? null;

  const [messageCount, meetingCount, goalCount] = await Promise.all([
    prisma.message.count({
      where: {
        senderId: mentorId,
        OR: [
          ...(relation ? [{ relationId: relation.id }] : []),
          { conversation: { type: 'DIRECT', participants: { some: { userId: menteeId } } } },
        ],
      },
    }),
    relation ? prisma.meeting.count({ where: { relationId: relation.id } }) : Promise.resolve(0),
    prisma.projectTask.count({ where: { assigneeId: menteeId } }),
  ]);

  const stored = readStoredSteps(record?.steps);
  const observed: Record<OnboardingStep, boolean> = {
    welcomeMessage: messageCount > 0,
    kickoffMeeting: meetingCount > 0,
    projectAndChat: Boolean(sharedProject),
    goals: goalCount > 0,
    pipeline: Boolean(relation && relation.pipelineStatus !== FIRST_STAGE),
    // Nothing observable: "did you actually look at their profile/CV?".
    profileReview: false,
  };

  const steps = Object.fromEntries(
    ONBOARDING_STEPS.map((step) => [
      step,
      { done: observed[step] || stored[step] === true, auto: observed[step] },
    ])
  ) as OnboardingState['steps'];

  return {
    menteeId,
    menteeName: mentee.fullName,
    relationId: relation?.id ?? null,
    projectId,
    startedAt: relation?.startDate ? relation.startDate.toISOString() : null,
    dismissedAt: record?.dismissedAt ? record.dismissedAt.toISOString() : null,
    steps,
    remaining: ONBOARDING_STEPS.filter((s) => !(observed[s] || stored[s] === true)).length,
  };
}

/** How recently a mentee has to have joined for the wizard to volunteer itself. */
export const ONBOARDING_PROMPT_DAYS = 60;

/**
 * The mentees this mentor still has onboarding work for: joined recently, the
 * checklist is not complete, and the mentor has not dismissed it.
 */
export async function pendingOnboardings(mentorId: string): Promise<OnboardingState[]> {
  const since = new Date(Date.now() - ONBOARDING_PROMPT_DAYS * 24 * 60 * 60 * 1000);
  const [relations, sharedMembers] = await Promise.all([
    prisma.mentorshipRelation.findMany({
      where: { mentorId, status: 'ACTIVE', startDate: { gte: since } },
      select: { menteeId: true },
    }),
    prisma.projectMember.findMany({
      where: {
        role: 'MENTEE',
        addedAt: { gte: since },
        project: { members: { some: { userId: mentorId, role: { in: ['OWNER', 'MENTOR'] } } } },
      },
      select: { userId: true },
    }),
  ]);
  const menteeIds = [...new Set([...relations.map((r) => r.menteeId), ...sharedMembers.map((m) => m.userId)])];
  if (menteeIds.length === 0) return [];

  const states = await Promise.all(menteeIds.map((id) => loadOnboardingState(mentorId, id)));
  return states
    .filter((s): s is OnboardingState => s !== null && !s.dismissedAt && s.remaining > 0)
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
}
