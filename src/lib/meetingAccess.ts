import { prisma } from '@/lib/prisma';
import { inCallerTenant } from '@/lib/tenantFilter';
import { meetingOrgSource, type MeetingParents } from '@/lib/meetingTenantRule';

// "Were you in this meeting, or did you call it?" — the one rule that governs a
// meeting row, wherever it is reached from.
//
// It was written for notes (#1056, `canAttachNoteToMeeting`, which now delegates
// here) and the call-token endpoint (#1237) needs exactly the same answer before
// it will sign anything: a token is scoped to a room, so handing one to a
// stranger is handing them the call.

export interface AccessibleMeeting {
  id: string;
  title: string;
  meetLink: string | null;
  createdById: string;
  /** True for the person who called the meeting (and for an admin). */
  organizer: boolean;
  /** The mentor of the relation this meeting hangs off, when it has one. */
  relationMentorId: string | null;
}

/**
 * The caller of every rule here. `orgId` is the session's org: a meeting of
 * another tenant is answered exactly like a missing one (#2542 follow-up). A
 * missing/null org is the DEFAULT org's, never a wildcard.
 */
export interface MeetingUser {
  id: string;
  role: string;
  orgId?: string | null;
}

/**
 * Is a meeting (or a recurring rule) with these parents inside the caller's
 * tenant? The parents decide (src/lib/meetingTenantRule.ts); only a row with
 * none — a DIRECT conversation, an instant room, an orphaned series — falls
 * back to the org of the person who called it.
 */
export async function meetingInCallerTenant(
  parents: MeetingParents,
  createdById: string,
  callerOrgId: string | null | undefined,
): Promise<boolean> {
  const source = meetingOrgSource(parents);
  const ownerOrgId =
    source === 'creator'
      ? ((await prisma.user.findUnique({ where: { id: createdById }, select: { orgId: true } }))?.orgId ?? null)
      : source.orgId;
  return inCallerTenant(ownerOrgId, callerOrgId);
}

// Returns the meeting when this user may take part in it, null otherwise —
// including when it does not exist, so a probe cannot tell the two apart.
export async function loadAccessibleMeeting(
  user: MeetingUser,
  meetingId: string
): Promise<AccessibleMeeting | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      title: true,
      meetLink: true,
      createdById: true,
      relation: { select: { mentorId: true, menteeId: true, orgId: true } },
      projectId: true,
      project: { select: { orgId: true } },
      conversationId: true,
      conversation: { select: { project: { select: { orgId: true } } } },
    },
  });
  if (!meeting) return null;
  // Another tenant's meeting does not exist for this caller — not even for an
  // admin, whose "any meeting" below means any meeting of their own tenant.
  if (!(await meetingInCallerTenant(meeting, meeting.createdById, user.orgId))) return null;

  const isAdmin = user.role === 'ADMIN';
  const isCreator = meeting.createdById === user.id;
  const found = {
    id: meeting.id,
    title: meeting.title,
    meetLink: meeting.meetLink,
    createdById: meeting.createdById,
    organizer: isCreator || isAdmin,
    relationMentorId: meeting.relation?.mentorId ?? null,
  };

  if (isCreator || isAdmin) return found;
  if (meeting.relation && (meeting.relation.mentorId === user.id || meeting.relation.menteeId === user.id)) {
    return found;
  }
  if (meeting.projectId) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: meeting.projectId, userId: user.id } },
      select: { id: true },
    });
    if (member) return found;
  }
  if (meeting.conversationId) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: meeting.conversationId, userId: user.id } },
      select: { id: true },
    });
    if (participant) return found;
  }
  return null;
}

export async function canAccessMeeting(
  user: MeetingUser,
  meetingId: string
): Promise<boolean> {
  return (await loadAccessibleMeeting(user, meetingId)) !== null;
}

// "May you MOVE this meeting, call it off, or delete it?" — a strictly narrower
// question than `loadAccessibleMeeting`, and it lives here so the two rules stay
// side by side instead of drifting apart in a route (#1980).
//
// Being in a meeting is not being in charge of it. The people who may change it
// are the one who called it, the mentor of the relation it hangs off, and an
// admin. A MENTEE is deliberately not among them: their answer to a time that
// does not work is to decline (and, once #1982 lands, to counter-propose) — a
// mentee moving the meeting their mentor called would be a change the organiser
// learns about from their calendar.
//
// Fail-closed in the #831 shape: the role allowlist is spelled out, so a session
// role this rule was never written for (COMPANY, SOURCE, anything added later)
// is refused rather than falling through to a participation check that might
// happen to pass. And "not yours" is answered by returning null exactly like
// "does not exist", so callers can 404 both and the id space stays opaque.
export async function canManageMeeting(
  user: MeetingUser,
  meetingId: string
): Promise<AccessibleMeeting | null> {
  if (user.role !== 'ADMIN' && user.role !== 'MENTOR') return null;
  const meeting = await loadAccessibleMeeting(user, meetingId);
  if (!meeting) return null;
  if (user.role === 'ADMIN') return meeting;
  // A MENTOR who neither called this meeting nor mentors the pair it belongs to
  // is a guest in it — a project room, a conversation — and may attend it, not
  // rewrite it.
  if (meeting.createdById === user.id || meeting.relationMentorId === user.id) return meeting;
  return null;
}
