import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { sendInvitationEmail } from '@/services/emailService';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { isProjectOwner } from '@/lib/projectAccess';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { z } from 'zod';
import crypto from 'crypto';

// Email invitations (#51).
//
// Who may invite whom, and what happens when the link is used:
//   ADMIN  → ADMIN | MENTOR | MENTEE. May name the mentor a new mentee should be
//            attached to (`mentorId`), or the mentee a new mentor should take on
//            (`menteeId`), and a project to join. Registering through the link
//            then creates that mentorship straight away — the same "click and you
//            are connected" behaviour a mentor's own invite has always had.
//   MENTOR → MENTEE. The mentorship is with the inviting mentor.
//   MENTEE → MENTEE. No mentorship (a mentee cannot mentor); the invitee is
//            recorded as referred by them.
// Every invitation also records `invitedById`, which becomes the new account's
// `referredById` — so admins and mentors count as a *source* just like mentees.
const inviteSchema = z.object({
  email: z.string().email('Invalid email'),
  role: z.enum(['MENTOR', 'MENTEE', 'ADMIN']),
  mentorId: z.string().min(1).optional().nullable(),
  menteeId: z.string().min(1).optional().nullable(),
  projectId: z.string().min(1).optional().nullable(),
});

const ALLOWED_ROLES: Record<string, ReadonlyArray<'MENTOR' | 'MENTEE' | 'ADMIN'>> = {
  ADMIN: ['ADMIN', 'MENTOR', 'MENTEE'],
  MENTOR: ['MENTEE'],
  MENTEE: ['MENTEE'],
};

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const allowed = session ? ALLOWED_ROLES[session.user.role] : undefined;
    if (!session || !allowed) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const body = await request.json();
      const parsed = inviteSchema.safeParse(body);

      if (!parsed.success) {
        return NextResponse.json(
          { error: 'Validation failed', details: parsed.error.flatten() },
          { status: 400 }
        );
      }

      const { email, role } = parsed.data;
      if (!allowed.includes(role)) {
        return NextResponse.json({ error: `You cannot invite a ${role.toLowerCase()}` }, { status: 403 });
      }

      // Who the invitee gets connected to. A mentor invites on their own behalf;
      // an admin picks the counterpart explicitly.
      let mentorId: string | null = null;
      let menteeId: string | null = null;
      if (session.user.role === 'MENTOR' && role === 'MENTEE') {
        mentorId = session.user.id;
      } else if (session.user.role === 'ADMIN') {
        mentorId = parsed.data.mentorId || null;
        menteeId = parsed.data.menteeId || null;
      }
      // Capacity/availability warning (#942): advisory only, mirrors POST
      // /api/mentorship and the request-approval endpoint's use of
      // getMentorAvailability(). The MentorshipRelation itself isn't created
      // yet here — that happens at registration (register/route.ts) — this
      // just warns the admin up front about the mentor they're pre-linking.
      let warnings: string[] = [];
      if (mentorId) {
        const mentor = await prisma.user.findUnique({
          where: { id: mentorId },
          select: { role: true, isActive: true, mentorCapacity: true, acceptingMentees: true },
        });
        if (!mentor?.isActive || (mentor.role !== 'MENTOR' && mentor.role !== 'ADMIN')) {
          return NextResponse.json({ error: 'The chosen mentor is not an active mentor' }, { status: 400 });
        }
        const activeMenteeCount = await prisma.mentorshipRelation.count({
          where: { mentorId, status: 'ACTIVE' },
        });
        const availability = getMentorAvailability({
          mentorCapacity: mentor.mentorCapacity,
          activeMenteeCount,
          acceptingMentees: mentor.acceptingMentees,
        });
        warnings =
          availability.status === 'at_capacity'
            ? ['mentor_at_capacity']
            : availability.status === 'not_accepting'
              ? ['mentor_not_accepting']
              : [];
      }
      if (menteeId) {
        const mentee = await prisma.user.findUnique({ where: { id: menteeId }, select: { role: true, isActive: true } });
        if (!mentee?.isActive || mentee.role !== 'MENTEE') {
          return NextResponse.json({ error: 'The chosen mentee is not an active mentee' }, { status: 400 });
        }
      }
      // A mentee invite may name a mentor; a mentor invite may name a mentee.
      if (role === 'MENTEE') menteeId = null;
      if (role === 'MENTOR') mentorId = null;
      if (role === 'ADMIN') { mentorId = null; menteeId = null; }

      // Only somebody who runs the project may hand out membership to it.
      const projectId: string | null = parsed.data.projectId || null;
      if (projectId && !(await isProjectOwner(session.user, projectId))) {
        return NextResponse.json({ error: 'You cannot add members to that project' }, { status: 403 });
      }

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        return NextResponse.json(
          { error: 'A user with this email already exists' },
          { status: 409 }
        );
      }

      const existingToken = await prisma.invitationToken.findFirst({
        where: { email, used: false, expiresAt: { gt: new Date() } },
      });
      if (existingToken) {
        return NextResponse.json(
          { error: 'An active invitation has already been sent to this email' },
          { status: 409 }
        );
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const invitation = await prisma.invitationToken.create({
        data: {
          token,
          email,
          role,
          expiresAt,
          invitedById: session.user.id,
          orgId: resolveOrgId(session),
          mentorId,
          menteeId,
          projectId,
        },
      });

      await logActivity({
        action: 'invite.created',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'invitation',
        targetId: invitation.id,
        detail: `${email} · ${role}`,
        request,
      });

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const registerUrl = `${appUrl}/auth/register?token=${token}`;

      // The token is already persisted, so a failed/blocked email must not lose the
      // invitation — the admin can still share registerUrl manually. Report delivery
      // status instead of 500-ing.
      let emailSent = false;
      try {
        await sendInvitationEmail({ to: email, token, role, orgId: resolveOrgId(session) });
        emailSent = !!process.env.SMTP_USER;
      } catch (mailErr) {
        console.error('Invitation email failed (token still valid):', mailErr);
      }

      return NextResponse.json(
        {
          message: emailSent ? 'Invitation sent' : 'Invitation created (share the link manually)',
          invitationId: invitation.id,
          registerUrl,
          emailSent,
          warnings,
        },
        { status: 201 }
      );
    });
  } catch (error) {
    console.error('Invite error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      // Admins audit every invitation; everyone else sees the ones they sent.
      const invitations = await prisma.invitationToken.findMany({
        where: session.user.role === 'ADMIN' ? {} : { invitedById: session.user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          used: true,
          createdAt: true,
          expiresAt: true,
          openedAt: true,
          registeredAt: true,
          verifiedAt: true,
          invitedBy: { select: { id: true, fullName: true } },
        },
      });

      return NextResponse.json({ invitations });
    });
  } catch (error) {
    console.error('Get invitations error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
