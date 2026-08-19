import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { isPendingActivation, isErasedAccount, isUnusableEmail } from '@/lib/menteeAccount';
import { IS_DEMO_MODE } from '@/lib/demoMode';
import { notify } from '@/lib/notify';
import { roleHome } from '@/lib/roleHome';
import { sendRoleChangeEmail } from '@/services/emailService';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          // Only to derive `pendingActivation` below — destructured out before
          // the response so the column never reaches a client.
          password: true,
          phone: true,
          whatsapp: true,
          city: true,
          // The candidate's own clock (#1210) — the meeting scheduler on this
          // screen previews the picked time on it before the invite goes out.
          timezone: true,
          birthDate: true,
          referralSource: true,
          sourceId: true,
          referredById: true,
          referredBy: { select: { id: true, fullName: true, role: true } },
          source: { select: { id: true, name: true } },
          university: true,
          department: true,
          graduationYear: true,
          skills: true,
          cvUrl: true,
          createdAt: true,
          mentorCapacity: true,
          // For mentor detail: their active mentees, pipeline stage, and the raw
          // evaluation scores (averaged on the client for a workload/quality view).
          mentorRelations: {
            orderBy: { startDate: 'desc' },
            select: {
              id: true,
              status: true,
              pipelineStatus: true,
              startDate: true,
              mentee: { select: { id: true, fullName: true, email: true } },
              company: { select: { name: true } },
              evaluations: { select: { scores: true } },
            },
          },
          menteeRelations: {
            orderBy: { startDate: 'desc' },
            include: {
              mentor: { select: { fullName: true, email: true } },
              company: { select: { name: true, industry: true } },
              project: { select: { id: true, name: true } },
              cohort: { select: { id: true, name: true } },
              interactions: { orderBy: { date: 'desc' } },
              statusChanges: {
                orderBy: { createdAt: 'desc' },
                include: { changedBy: { select: { fullName: true } } },
              },
            },
          },
        },
      });

      if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }

      // A mentee record typed in by a mentor (or imported) has a sentinel where
      // the hash goes and can never sign in — the candidate page offers to fix
      // the address and send the activation link (#1123).
      const { password, ...rest } = user;

      return NextResponse.json({
        user: { ...rest, pendingActivation: isPendingActivation({ password }) },
      });
    });
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH — admin updates a user's account flags (currently: active/inactive).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return await withTenantScope(session, async () => {
      const body = await request.json();
      const data: {
        isActive?: boolean;
        pendingApproval?: boolean;
        sourceId?: string | null;
        referredById?: string | null;
        skills?: string[];
        mentorCapacity?: number | null;
        role?: 'MENTOR' | 'MENTEE';
        sessionsValidFrom?: Date;
      } = {};
      let roleUnchanged = false;
      let previousRole: string | null = null;
      let convertedUser: { email: string; fullName: string; preferredLanguage: string | null; orgId: string | null } | null = null;

      if (typeof body.isActive === 'boolean') {
        // Guard against an admin locking themselves out.
        if (id === session.user.id && body.isActive === false) {
          return NextResponse.json({ error: 'You cannot deactivate your own account' }, { status: 400 });
        }
        data.isActive = body.isActive;
        // An admin decision outranks the self-service door, so activating always
        // clears the "waiting for an admin" flag.
        //
        // Deactivating only *sets* it for an account that never got in. An
        // unverified sign-up still holds a verification link, and clicking it
        // would otherwise re-admit the account it was just rejected from
        // (src/app/api/auth/verify-email/route.ts). A verified account is
        // already barred there by its own `emailVerified`, so parking it too
        // buys no safety and costs it an honest sign-in message: pendingApproval
        // is exactly what lets /auth/signin tell "waiting for a review" apart
        // from "an admin switched you off" (#1085). Setting it on every
        // deactivation collapsed that distinction and told a deactivated user to
        // wait for an email that is never coming.
        if (body.isActive) {
          data.pendingApproval = false;
        } else {
          const target = await prisma.user.findUnique({ where: { id }, select: { emailVerified: true } });
          data.pendingApproval = target ? !target.emailVerified : false;
        }
      }

      // Assign / clear the mentee's referral source.
      if ('sourceId' in body && (typeof body.sourceId === 'string' || body.sourceId === null)) {
        data.sourceId = body.sourceId || null;
      }

      // Who brought this person in (#51). Any person — mentee, mentor or admin —
      // can be the source, so this is a plain user pointer rather than a Source
      // row; it is also set automatically by invitation/referral links. Self-
      // reference would make the "who referred whom" tree lie.
      if ('referredById' in body && (typeof body.referredById === 'string' || body.referredById === null)) {
        const target = body.referredById || null;
        if (target === id) {
          return NextResponse.json({ error: 'A user cannot be their own source' }, { status: 400 });
        }
        if (target) {
          const referrer = await prisma.user.findUnique({ where: { id: target }, select: { role: true } });
          if (!referrer || !['ADMIN', 'MENTOR', 'MENTEE'].includes(referrer.role)) {
            return NextResponse.json({ error: 'Invalid source user' }, { status: 400 });
          }
        }
        data.referredById = target;
      }

      // Mentor expertise (skills) — admin can populate so skill-match works.
      if (Array.isArray(body.skills) && body.skills.every((s: unknown) => typeof s === 'string')) {
        data.skills = [...new Set((body.skills as string[]).map((s) => s.trim()).filter(Boolean))];
      }

      // Role conversion (#1243): a mentee graduates into mentoring, a mentor
      // steps back into a mentee seat. Only between those two people-roles —
      // ADMIN is deliberately not grantable here (no privilege escalation via a
      // routine PATCH; demoting an admin is also out, so the last-admin case
      // can't arise), and COMPANY/SOURCE accounts carry structural links a
      // flip would orphan. Open relations survive: the shells are derived from
      // the relation table (src/lib/dualRole.ts, #1141), so a converted mentor
      // still reaches their mentees and vice versa.
      if ('role' in body) {
        // The demo's accounts are shared, and converting one stamps the
        // sign-out-all cutoff — one visitor would sign every other visitor out
        // of it and park the advertised "mentor" login in the mentee portal
        // until the next reset. The path-level DEMO_BLOCKED_WRITES list can't
        // carry this (it would also kill the benign activate/skills edits on
        // this same route), so the field is refused here instead.
        if (IS_DEMO_MODE) {
          return NextResponse.json(
            { error: 'This is a shared demo, so that action is disabled here — it signs every other visitor out of the account.' },
            { status: 403 }
          );
        }
        if (body.role !== 'MENTOR' && body.role !== 'MENTEE') {
          return NextResponse.json({ error: 'Role can only be changed to MENTOR or MENTEE' }, { status: 400 });
        }
        const target = await prisma.user.findUnique({
          where: { id },
          // email/fullName/preferredLanguage/orgId feed the post-update notice
          // to the converted person (#1252).
          select: { role: true, email: true, fullName: true, preferredLanguage: true, orgId: true },
        });
        if (!target) {
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        if (target.role !== 'MENTOR' && target.role !== 'MENTEE') {
          return NextResponse.json({ error: 'Only MENTOR and MENTEE accounts can be converted' }, { status: 400 });
        }
        // An erased account is anonymized history, not a person to repurpose —
        // and erasure rewrites the address to a sentinel that must never be
        // mailed (same refusal as PATCH /api/mentor/mentees/[id]).
        if (isErasedAccount(target)) {
          return NextResponse.json({ error: 'This account has been erased' }, { status: 400 });
        }
        if (target.role === body.role) {
          // Idempotent no-op: a second tab (or second admin) whose row was
          // stale re-sends the role the account already has. Success, not a
          // cryptic "No supported fields" 400 — the state they asked for is
          // the state that exists.
          roleUnchanged = true;
        } else {
          previousRole = target.role;
          convertedUser = target;
          data.role = body.role;
          // `role` lives in the JWT from sign-in until an explicit update(), so
          // without this a demoted mentor would keep a live staff-shell token.
          // Revoke every session (the sign-out-all cutoff); the next sign-in
          // mints the new role — and walks promotion through the 2FA setup gate
          // if the org policy covers mentors.
          data.sessionsValidFrom = new Date();
        }
      }

      // Mentor active-mentee capacity (null clears it).
      if ('mentorCapacity' in body) {
        const c = body.mentorCapacity;
        if (c === null || c === '') {
          data.mentorCapacity = null;
        } else if (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 999) {
          data.mentorCapacity = c;
        } else {
          return NextResponse.json({ error: 'Invalid mentorCapacity' }, { status: 400 });
        }
      }

      if (Object.keys(data).length === 0) {
        if (roleUnchanged) {
          return NextResponse.json({ user: { id, role: body.role } });
        }
        return NextResponse.json({ error: 'No supported fields to update' }, { status: 400 });
      }

      const user = await prisma.user.update({
        where: { id },
        data,
        select: { id: true, isActive: true, sourceId: true, referredById: true, skills: true, mentorCapacity: true, role: true },
      });

      // Activation state is the security-relevant part of this endpoint — it is
      // what lets someone in or keeps them out — so it gets its own audit row
      // at warning level (#878). Skills/capacity/source edits are routine.
      if (typeof data.isActive === 'boolean') {
        await logActivity({
          action: data.isActive ? 'user.activated' : 'user.deactivated',
          level: 'warning',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'user',
          targetId: id,
          request,
        });
      }

      // A role change alters what the account can reach — same audit weight as
      // switching it on or off (#1243).
      if (data.role) {
        await logActivity({
          action: 'user.role_changed',
          level: 'warning',
          actorId: session.user.id,
          actorEmail: session.user.email ?? null,
          targetType: 'user',
          targetId: id,
          detail: `role ${previousRole} → ${data.role}`,
          request,
        });
      }

      // Tell the person what just happened to them (#1252): the conversion
      // signed them out of every device mid-whatever-they-were-doing. The
      // in-app notice waits for them after the forced re-login; the email is
      // sent unconditionally (an account-level notice like a password reset,
      // not an opt-out-able digest). Both fire-and-forget — the conversion
      // already happened, a notification failure must not report it as failed.
      if (data.role && convertedUser) {
        const newRole = data.role;
        await notify(
          id,
          newRole === 'MENTOR' ? 'role_changed.toMentor' : 'role_changed.toMentee',
          {},
          roleHome(newRole)
        );
        // Not to a sentinel address: a mentor-entered candidate has a generated
        // @import.local stand-in that only bounces off the relay.
        if (!isUnusableEmail(convertedUser.email)) {
          sendRoleChangeEmail({
            to: convertedUser.email,
            fullName: convertedUser.fullName,
            newRole,
            locale: convertedUser.preferredLanguage,
            orgId: convertedUser.orgId,
          }).catch((e) => console.error('sendRoleChangeEmail failed:', e));
        }
      }

      return NextResponse.json({ user });
    });
  } catch (error) {
    console.error('Update user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
