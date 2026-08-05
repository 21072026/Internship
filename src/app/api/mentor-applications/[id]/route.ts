import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import crypto from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { sendInvitationEmail, sendMentorApplicationRejectionEmail } from '@/services/emailService';

// Admin decision on a mentor application (#906), building on the #904 model/API
// (src/app/api/mentor-applications/route.ts) — no new model, no duplicate
// endpoint.
//
//   APPROVED: a 7-day InvitationToken (role MENTOR) is created and the same
//             invite email an admin-created invitation gets is sent. No User
//             is created here — that happens when the applicant registers
//             through the link, same as any other invitation.
//   REJECTED: rejectReason is required and stored for the admin trail only;
//             the applicant gets a polite, generic decline (never the reason).
//
// Both paths guard against a double-decide with a conditional `updateMany`
// (`status: 'PENDING'` in the `where`) run inside the transaction that also
// creates the InvitationToken, so a double click or retried request can never
// send two invitations or flip a decided application — the loser gets 409.

const decideSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    rejectReason: z.string().max(TEXT_LIMITS.mentorApplicationRejectReason).optional(),
  })
  .refine((d) => d.action !== 'reject' || !!d.rejectReason?.trim(), {
    message: 'A rejection reason is required',
    path: ['rejectReason'],
  });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;

  return await withTenantScope(session, async () => {
    const parsed = decideSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Validation failed' },
        { status: 400 }
      );
    }
    const { action, rejectReason } = parsed.data;

    const application = await prisma.mentorApplication.findUnique({ where: { id } });
    if (!application) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 });
    }
    if (application.status !== 'PENDING') {
      return NextResponse.json({ error: 'Application already decided', code: 'already_decided' }, { status: 409 });
    }

    const now = new Date();

    if (action === 'approve') {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const invitation = await prisma.$transaction(async (tx) => {
        const claimed = await tx.mentorApplication.updateMany({
          where: { id, status: 'PENDING' },
          data: { status: 'APPROVED', decidedAt: now, decidedById: session.user.id },
        });
        if (claimed.count === 0) return null;
        return tx.invitationToken.create({
          data: { token, email: application.email, role: 'MENTOR', expiresAt, invitedById: session.user.id },
        });
      });
      if (!invitation) {
        return NextResponse.json({ error: 'Application already decided', code: 'already_decided' }, { status: 409 });
      }

      await logActivity({
        action: 'mentor_application.decided',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'mentor_application',
        targetId: id,
        detail: `approved · invitation ${invitation.id}`,
        request,
      });

      // The decision and the invitation are already committed — a failed send
      // must not undo either; the admin can still share the link manually via
      // the existing "Recent Invitations" list.
      try {
        await sendInvitationEmail({ to: application.email, token, role: 'MENTOR', orgId: resolveOrgId(session) });
      } catch (e) {
        console.error('Mentor application approval email failed (invitation still valid):', e);
      }

      return NextResponse.json({ ok: true, invitationId: invitation.id });
    }

    const reason = rejectReason!.trim();
    const claimed = await prisma.mentorApplication.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: now, decidedById: session.user.id, rejectReason: reason },
    });
    if (claimed.count === 0) {
      return NextResponse.json({ error: 'Application already decided', code: 'already_decided' }, { status: 409 });
    }

    await logActivity({
      action: 'mentor_application.decided',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'mentor_application',
      targetId: id,
      detail: `rejected · ${reason.slice(0, 200)}`,
      request,
    });

    try {
      await sendMentorApplicationRejectionEmail({
        to: application.email,
        fullName: application.fullName,
        orgId: resolveOrgId(session),
      });
    } catch (e) {
      console.error('Mentor application rejection email failed:', e);
    }

    return NextResponse.json({ ok: true });
  });
}
