import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { enforceRateLimit } from '@/lib/rateLimit';
import { createPasswordResetToken } from '@/lib/passwordReset';
import { sendPasswordResetEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { isErasedAccount, isPendingActivation, isUnusableEmail } from '@/lib/menteeAccount';

const schema = z.object({ email: z.string().email() });

// PATCH — set the real e-mail on a mentee record and send the activation link.
//
// A mentee a mentor added by hand (or a CSV import) has no password and often a
// generated `@import.local` address, so it can never sign in and no reset mail
// can reach it. Once the mentor learns the real address this promotes the
// existing record — with its interaction log and stage history — into a real
// account, instead of the only alternatives available before (#1123): delete
// and re-create, or register a second, unrelated user.
//
// Re-sending with the address unchanged is allowed, so the same action doubles
// as "the mail never arrived, send it again".
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);
    if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // The endpoint sends mail to an address chosen by the caller, so it is
    // bounded even though the caller is authenticated.
    const limited = enforceRateLimit(request, 'mentee-activation', { limit: 20, windowMs: 15 * 60 * 1000 });
    if (limited) return limited;

    return await withTenantScope(session, async () => {
      const parsed = schema.safeParse(await request.json());
      if (!parsed.success) {
        return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
      }
      // Normalized the same way registration and sign-in normalize, so the
      // account can actually be found again afterwards.
      const email = parsed.data.email.trim().toLowerCase();
      if (isUnusableEmail(email)) {
        return NextResponse.json({ error: 'That address is a placeholder, not a real mailbox' }, { status: 400 });
      }

      const mentee = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, fullName: true, role: true, password: true, isActive: true, orgId: true },
      });
      if (!mentee || mentee.role !== 'MENTEE') {
        return NextResponse.json({ error: 'Mentee not found' }, { status: 404 });
      }

      // A mentor may only touch their own mentee; an admin any mentee in scope.
      if (session.user.role !== 'ADMIN') {
        const relation = await prisma.mentorshipRelation.findFirst({
          where: { mentorId: session.user.id, menteeId: mentee.id },
          select: { id: true },
        });
        if (!relation) {
          return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }
      }

      // The whole point of the guard: once someone has set a password, the
      // address is *theirs*. Letting a mentor re-point it at a mailbox they
      // control, then mailing themselves a set-password link, would be account
      // takeover. Those users change their own e-mail via /api/account, which
      // re-authenticates them first.
      if (!isPendingActivation(mentee)) {
        return NextResponse.json(
          { error: 'This mentee already has a password; only they can change their e-mail' },
          { status: 409 }
        );
      }
      // Erased records keep the sentinel password but must stay erased.
      if (isErasedAccount(mentee) || !mentee.isActive) {
        return NextResponse.json({ error: 'This account is not active' }, { status: 409 });
      }

      const changingEmail = email !== mentee.email;
      if (changingEmail) {
        const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (taken) {
          return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
        }
        await prisma.user.update({ where: { id: mentee.id }, data: { email } });
      }

      const token = await createPasswordResetToken(mentee.id, 'SET_INITIAL');
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const setPasswordUrl = `${appUrl}/auth/reset?token=${token}`;
      let emailSent = true;
      try {
        await sendPasswordResetEmail({
          to: email,
          token,
          fullName: mentee.fullName,
          purpose: 'SET_INITIAL',
          orgId: mentee.orgId,
        });
      } catch (e) {
        console.error('Mentee activation email failed:', e);
        emailSent = false;
      }

      // Returning the link is what #875 removed from the *admin reset* endpoint,
      // and deliberately not the same thing: there the target is a live account
      // whose owner reads their own mailbox, so handing the token to a third
      // party is takeover. Here the record has never been an account — the same
      // link is already returned when the mentor creates a mentee with a real
      // address (POST /api/mentor/mentees) — so there is nothing to take over,
      // and the mentor needs a way through when SMTP is down.
      await logActivity({
        action: 'mentee.activation_link_sent',
        level: 'warning',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'user',
        targetId: mentee.id,
        detail: changingEmail ? `${mentee.email} → ${email}` : `resent to ${email}`,
        request,
      });

      return NextResponse.json({ ok: true, email, emailSent, setPasswordUrl });
    });
  } catch (error) {
    console.error('Mentee activation error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
