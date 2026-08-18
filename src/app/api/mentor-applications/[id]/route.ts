import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import crypto from 'crypto';
import type { Session } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { emailAllowed } from '@/lib/notificationPrefs';
import {
  sendMentorApplicationUnderReviewEmail,
  sendMentorApplicationApprovedEmail,
  sendMentorApplicationRejectedEmail,
} from '@/services/emailService';

// Admin decide endpoint for #904 mentor applications (#933): take into review,
// approve (creates or upgrades the MENTOR account), or reject. Mirrors the
// mentorship-requests decide endpoint (src/app/api/admin/mentorship-requests/route.ts):
// a status guard via a conditional updateMany makes every action idempotent —
// a second call (double click, retry) sees the row already decided and no-ops
// with 409 instead of repeating the side effects.

const DECIDABLE = ['PENDING', 'UNDER_REVIEW'] as const;

async function requireAdmin(): Promise<{ session: Session } | { error: NextResponse }> {
  const session = await getServerSession(authOptions);
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (session.user.role !== 'ADMIN') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { session };
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  return await withTenantScope(auth.session, async () => {
    const application = await prisma.mentorApplication.findUnique({ where: { id } });
    if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ application });
  });
}

const decideSchema = z.object({
  action: z.enum(['review', 'approve', 'reject', 'note']),
  reason: z.string().min(1).max(2000).optional(),
  note: z.string().max(2000).optional(),
});

// A signal (not a real error) used to unwind the approve transaction when the
// email belongs to an account whose role we must not silently repurpose.
class RoleConflictError extends Error {}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const { session } = auth;
  const { id } = await params;

  const parsed = decideSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { action, reason, note } = parsed.data;
  if (action === 'reject' && !reason?.trim()) {
    return NextResponse.json({ error: 'A rejection reason is required' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const application = await prisma.mentorApplication.findUnique({
      where: { id },
      select: { id: true, status: true, fullName: true, email: true, locale: true, orgId: true, capacity: true, expertise: true },
    });
    if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (action === 'note') {
      await prisma.mentorApplication.update({ where: { id }, data: { rejectReason: note ?? '' } });
      await logActivity({
        action: 'mentor_application.note_saved',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'mentor_application',
        targetId: id,
        request,
      });
      return NextResponse.json({ ok: true });
    }

    if (action === 'review') {
      const updated = await prisma.mentorApplication.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'UNDER_REVIEW' },
      });
      if (updated.count === 0) {
        return NextResponse.json({ error: 'Already decided or already under review', code: 'already_decided' }, { status: 409 });
      }
      // Not awaited — a slow/unreachable SMTP server must not hold up the
      // admin's click (see the identical note in the public POST handler).
      void sendMentorApplicationUnderReviewEmail({
        to: application.email,
        fullName: application.fullName,
        locale: application.locale,
        orgId: application.orgId,
      }).catch((e) => console.error('Mentor application under-review email failed:', e));
      await logActivity({
        action: 'mentor_application.decided',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'mentor_application',
        targetId: id,
        detail: 'under_review',
        request,
      });
      return NextResponse.json({ ok: true, status: 'UNDER_REVIEW' });
    }

    if (action === 'reject') {
      const updated = await prisma.mentorApplication.updateMany({
        where: { id, status: { in: [...DECIDABLE] } },
        data: { status: 'REJECTED', decidedAt: new Date(), decidedById: session.user.id, rejectReason: reason },
      });
      if (updated.count === 0) {
        return NextResponse.json({ error: 'Already decided', code: 'already_decided' }, { status: 409 });
      }
      void sendMentorApplicationRejectedEmail({
        to: application.email,
        fullName: application.fullName,
        locale: application.locale,
        orgId: application.orgId,
      }).catch((e) => console.error('Mentor application rejection email failed:', e));
      await logActivity({
        action: 'mentor_application.decided',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'mentor_application',
        targetId: id,
        detail: 'rejected',
        request,
      });
      return NextResponse.json({ ok: true, status: 'REJECTED' });
    }

    // action === 'approve' — the status flip and the account-side write must
    // succeed or fail together: an application is only ever left APPROVED if
    // the account operation actually worked.
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.mentorApplication.updateMany({
        where: { id, status: { in: [...DECIDABLE] } },
        data: { status: 'APPROVED', decidedAt: new Date(), decidedById: session.user.id },
      });
      if (updated.count === 0) return { outcome: 'already_decided' as const };

      const existingUser = await tx.user.findUnique({
        where: { email: application.email },
        select: {
          id: true,
          role: true,
          email: true,
          fullName: true,
          orgId: true,
          emailNotifications: true,
          notificationPrefs: true,
          skills: true,
          mentorCapacity: true,
        },
      });

      if (existingUser) {
        // Never silently repurpose an ADMIN/COMPANY/SOURCE account's role —
        // only a MENTEE (or an already-MENTOR account) is safe to touch.
        if (existingUser.role !== 'MENTEE' && existingUser.role !== 'MENTOR') {
          throw new RoleConflictError();
        }
        const user = existingUser.role === 'MENTOR'
          ? existingUser
          : await tx.user.update({
              where: { id: existingUser.id },
              data: {
                role: 'MENTOR',
                mentorCapacity: existingUser.mentorCapacity ?? application.capacity ?? undefined,
                // Only fill in skills if the account has none yet — never
                // overwrite what the person already curated on their profile.
                skills: Array.isArray(existingUser.skills) && existingUser.skills.length > 0
                  ? undefined
                  : ((application.expertise ?? []) as Prisma.InputJsonValue),
              },
              select: {
                id: true, role: true, email: true, fullName: true, orgId: true,
                emailNotifications: true, notificationPrefs: true, skills: true, mentorCapacity: true,
              },
            });
        return { outcome: 'promoted' as const, user };
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const invitation = await tx.invitationToken.create({
        data: { token, email: application.email, role: 'MENTOR', expiresAt, invitedById: session.user.id },
      });
      return { outcome: 'invited' as const, invitation };
    }).catch((e) => {
      if (e instanceof RoleConflictError) return { outcome: 'role_conflict' as const };
      throw e;
    });

    if (result.outcome === 'already_decided') {
      return NextResponse.json({ error: 'Already decided', code: 'already_decided' }, { status: 409 });
    }
    if (result.outcome === 'role_conflict') {
      return NextResponse.json(
        { error: 'An account with a different role already exists for this email', code: 'role_conflict' },
        { status: 409 }
      );
    }

    if (result.outcome === 'promoted') {
      const user = result.user;
      if (user.email && emailAllowed(user, 'mentorship')) {
        void sendMentorApplicationApprovedEmail({
          to: user.email,
          fullName: user.fullName,
          locale: application.locale,
          orgId: user.orgId,
        }).catch((e) => console.error('Mentor application approval email failed:', e));
      }
      await notify(user.id, 'mentor_application.approved', {}, '/mentor');
    } else {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      void sendMentorApplicationApprovedEmail({
        to: application.email,
        fullName: application.fullName,
        locale: application.locale,
        orgId: application.orgId,
        registerUrl: `${appUrl}/auth/register?token=${result.invitation.token}`,
      }).catch((e) => console.error('Mentor application approval email failed:', e));
    }

    await logActivity({
      action: 'mentor_application.decided',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'mentor_application',
      targetId: id,
      detail: `approved · ${result.outcome}`,
      request,
    });

    return NextResponse.json({ ok: true, status: 'APPROVED', accountAction: result.outcome });
  });
}
