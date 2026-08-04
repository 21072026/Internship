import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';

// A meeting hangs off exactly one context (#1051). MySQL can't express
// "exactly one of three columns is set" as a CHECK constraint, so the rule is
// enforced here and every write path goes through `resolveMeetingContext`.

export type MeetingContextKind = 'RELATION' | 'PROJECT' | 'CONVERSATION';

export interface MeetingContextInput {
  relationIds?: string[];
  projectId?: string;
  conversationId?: string;
}

export interface Invitee {
  userId: string;
  email: string;
  fullName: string | null;
  timezone?: string | null;
  emailNotifications?: boolean | null;
  notificationPrefs?: unknown;
  // Set only for RELATION context: the relation this invitee is reached through,
  // so the caller can keep writing one Meeting row (and one RSVP token) per
  // relation, exactly as /api/meetings always has.
  relationId?: string;
}

export type ResolvedMeetingContext =
  | { ok: true; kind: MeetingContextKind; relationIds: string[]; projectId: string | null; conversationId: string | null; invitees: Invitee[] }
  | { ok: false; status: 400 | 403 | 404; error: string };

interface SessionUser {
  id: string;
  role: string;
  companyId?: string | null;
}

// How many context keys the input sets. Anything but 1 is a client bug.
export function countContexts(input: MeetingContextInput): number {
  let n = 0;
  if (input.relationIds && input.relationIds.length > 0) n++;
  if (input.projectId) n++;
  if (input.conversationId) n++;
  return n;
}

// The shared video room. Jitsi needs no account and — unlike Meet/Zoom — allows
// being embedded in an iframe, which is what the in-app side panel relies on.
// Server-only (node:crypto); the embeddability check lives in @/lib/meetingLink
// so client components can import it.
export function generateMeetingLink(): string {
  return `https://meet.jit.si/InternshipCRM-${randomBytes(8).toString('hex')}`;
}

const INVITEE_SELECT = {
  id: true,
  email: true,
  fullName: true,
  timezone: true,
  emailNotifications: true,
  notificationPrefs: true,
} as const;

// Validate the context and resolve who gets invited — always server-side:
// hiding a button is not authorization.
export async function resolveMeetingContext(
  user: SessionUser,
  input: MeetingContextInput
): Promise<ResolvedMeetingContext> {
  const contexts = countContexts(input);
  if (contexts !== 1) {
    return { ok: false, status: 400, error: 'Exactly one of relationIds, projectId or conversationId is required' };
  }

  if (input.projectId) {
    // Read the project first: Project is a TENANT_MODEL (src/lib/orgContext.ts)
    // so this lookup is org-scoped, while ProjectMember is not — querying
    // members directly would reach across tenants.
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) return { ok: false, status: 404, error: 'Project not found' };

    const members = await prisma.projectMember.findMany({
      where: { projectId: input.projectId },
      select: { userId: true, role: true, user: { select: INVITEE_SELECT } },
    });
    if (members.length === 0) {
      // Either the project doesn't exist or it has no members — same answer, so
      // a probe can't tell the two apart.
      return { ok: false, status: 404, error: 'Project not found' };
    }
    const me = members.find((m) => m.userId === user.id);
    // Admins reach every project; otherwise only OWNER/MENTOR members may start
    // a meeting for the whole team (mentee members join, they don't summon).
    if (user.role !== 'ADMIN' && (!me || me.role === 'MENTEE')) {
      return { ok: false, status: 403, error: 'Forbidden' };
    }
    return {
      ok: true,
      kind: 'PROJECT',
      relationIds: [],
      projectId: input.projectId,
      conversationId: null,
      invitees: members
        .filter((m) => m.userId !== user.id)
        .map((m) => ({ userId: m.userId, ...m.user, email: m.user.email })),
    };
  }

  if (input.conversationId) {
    const participants = await prisma.conversationParticipant.findMany({
      where: { conversationId: input.conversationId },
      select: { userId: true, user: { select: INVITEE_SELECT } },
    });
    if (participants.length === 0) {
      return { ok: false, status: 404, error: 'Conversation not found' };
    }
    // Every participant of a chat may start a call in it; a non-participant may
    // not, admin or otherwise — reading someone else's thread is not the point.
    if (!participants.some((p) => p.userId === user.id)) {
      return { ok: false, status: 403, error: 'Forbidden' };
    }
    return {
      ok: true,
      kind: 'CONVERSATION',
      relationIds: [],
      projectId: null,
      conversationId: input.conversationId,
      invitees: participants
        .filter((p) => p.userId !== user.id)
        .map((p) => ({ userId: p.userId, ...p.user, email: p.user.email })),
    };
  }

  const relationIds = input.relationIds ?? [];
  // Same scoping rule as /api/meetings: an admin schedules for any relation, a
  // mentor only for their own.
  const where =
    user.role === 'ADMIN'
      ? { id: { in: relationIds } }
      : { id: { in: relationIds }, mentorId: user.id };
  const relations = await prisma.mentorshipRelation.findMany({
    where,
    select: { id: true, mentee: { select: INVITEE_SELECT } },
  });
  if (relations.length === 0) {
    return { ok: false, status: 404, error: 'No accessible relations' };
  }
  return {
    ok: true,
    kind: 'RELATION',
    relationIds: relations.map((r) => r.id),
    projectId: null,
    conversationId: null,
    invitees: relations.map((r) => ({
      userId: r.mentee.id,
      ...r.mentee,
      email: r.mentee.email,
      relationId: r.id,
    })),
  };
}
