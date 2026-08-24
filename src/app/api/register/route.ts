import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { defaultOrgId } from '@/lib/defaultOrg';
import { z } from 'zod';
import { createEmailVerificationToken } from '@/lib/emailVerification';
import { sendVerificationEmail } from '@/services/emailService';
import { passwordSchema } from '@/lib/password';
import { notify } from '@/lib/notify';
import { PRIVACY_POLICY_VERSION } from '@/lib/privacy';
import { resolveReferrer } from '@/lib/referral';
import { createOrGetProjectConversation } from '@/lib/conversations';
import { getSetting } from '@/lib/settings';
import { isValidTimeZone } from '@/lib/timezone';
import { findPossibleDuplicates } from '@/lib/duplicateDetection';

const registerSchema = z.object({
  token: z.string().optional(),
  // Personal referral code from /auth/register?ref=<code> (#51). Only read when
  // there is no invitation token — an invitation already names its sender.
  ref: z.string().max(64).optional(),
  email: z.string().email('Invalid email'),
  password: passwordSchema,
  fullName: z.string().min(1, 'Full name is required'),
  // Consent to the privacy notice/terms. Optional for backward compatibility;
  // when sent it must be true. `privacyVersion` records which notice version
  // was shown (GDPR Art. 7 demonstrability).
  consent: z.boolean().optional(),
  privacyVersion: z.string().optional(),
  // The IANA zone the browser was in when the account was created (#1210).
  // Recorded here so the very first emails — verification, the invitation that
  // brought them in, a meeting booked on day one — already land on the new
  // user's own clock instead of the deployment default, which is what they got
  // until they happened to open the app and TimezoneSync noticed. An invalid or
  // absent value is simply dropped: registration must never fail over this.
  timezone: z.string().max(80).optional(),
});

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'register', { limit: 15, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

  try {
    const body = await request.json();
    const parsed = registerSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { token, password, fullName } = parsed.data;
    // Normalize email (trim + lowercase) so the account is looked up
    // consistently everywhere afterwards (sign-in, forgot-password) — a
    // casing/whitespace difference otherwise creates a "can't find my account"
    // dead-end and silent forgot-password no-ops.
    const email = parsed.data.email.trim().toLowerCase();

    // If consent was explicitly provided, it must be affirmative.
    if (parsed.data.consent === false) {
      return NextResponse.json({ error: 'Consent to the privacy notice is required' }, { status: 400 });
    }

    // With a token: validate the invitation and use its role.
    // Without a token: open self-registration creates a MENTEE (#589) — mentees
    // are the self-serve intake; mentors/companies/sources arrive by invitation.
    // Same safety net as before: unverified email + inactive until admin approval.
    let role: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY' | 'SOURCE' = 'MENTEE';
    // Set from the invitation (its sender) or from a referral code, and written
    // onto the new account so "who brought this person in" is answerable later.
    let referredById: string | null = null;
    let invitedOrgId: string | null = null;
    // The address the invitation itself named, if any — null for an email-less
    // shareable link, which is what separates "proven address" from "typed in".
    let invitationEmail: string | null = null;
    let autoLink: { mentorId?: string | null; menteeId?: string | null; projectId?: string | null } = {};

    if (token) {
      const invitation = await prisma.invitationToken.findUnique({ where: { token } });
      if (!invitation) {
        return NextResponse.json({ error: 'Invalid invitation token' }, { status: 400 });
      }
      if (invitation.used) {
        return NextResponse.json({ error: 'Invitation token has already been used' }, { status: 400 });
      }
      if (invitation.expiresAt < new Date()) {
        return NextResponse.json({ error: 'Invitation token has expired' }, { status: 400 });
      }
      // A named invitation is bound to its address; an email-less shareable link
      // (#670) has none to match, so the registrant's own address is taken as
      // given — and written back onto the invitation further down, so the row
      // still ends up naming who used it.
      if (invitation.email && invitation.email.toLowerCase() !== email.toLowerCase()) {
        return NextResponse.json({ error: 'Email does not match the invitation' }, { status: 400 });
      }
      invitationEmail = invitation.email;
      role = invitation.role;
      referredById = invitation.invitedById;
      invitedOrgId = invitation.orgId;
      autoLink = { mentorId: invitation.mentorId, menteeId: invitation.menteeId, projectId: invitation.projectId };
    } else {
      // An open registration may still carry a referral link.
      const referrer = await resolveReferrer(parsed.data.ref);
      if (referrer?.isActive) referredById = referrer.id;
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // An invitation *addressed to someone* proves the email belongs to the
    // registrant — it only reached them because they read that mailbox — so
    // those accounts are verified immediately. An email-less shareable link
    // (#670) proves nothing about whatever address gets typed into the form, so
    // it follows the self-registration path: created unverified, with a
    // verification link on its way. The account is still active either way; the
    // inviter vouched for the person, not for the mailbox.
    const emailVerified = !!token && !!invitationEmail;
    // Open (token-less) self-registration is created inactive, but the gate it
    // waits behind depends on the `selfRegistration` setting: 'auto' (default)
    // lets the account in as soon as the emailed link is clicked — the front
    // door is open to anyone — while 'manual' parks it for an admin. Invited
    // users (proven email + chosen role) are active right away.
    const pending = !token && (await getSetting('selfRegistration')) === 'manual';
    const selfRegistered = !token;

    const timezone = isValidTimeZone(parsed.data.timezone) ? parsed.data.timezone : null;

    // Assign the tenant at creation time (#1272): invited users inherit the
    // inviter's org (carried on the InvitationToken), everyone else gets the
    // default org — the same one the deploy backfill would assign. Without
    // this, fail-closed org scoping (#1227) 403s an invited COMPANY user's
    // portal until the next deploy runs the backfill.
    const orgId = invitedOrgId ?? (await defaultOrgId());

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, fullName, role, skills: [], emailVerified, isActive: !selfRegistered, pendingApproval: pending, consentAt: new Date(), referredById, timezone, orgId },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true, orgId: true },
    });

    // Record which privacy-notice version was accepted, so consent is auditable
    // and re-consent can be requested when the notice changes (GDPR Art. 7).
    await prisma.userConsent.create({
      data: {
        userId: user.id,
        type: 'PRIVACY_POLICY',
        version: parsed.data.privacyVersion ?? PRIVACY_POLICY_VERSION,
        grantedAt: new Date(),
      },
    });

    if (token) {
      // Advance the invitation lifecycle: registered now, and (since invited
      // users are verified immediately) verified at the same moment. openedAt is
      // backfilled in case the "opened" ping never landed (e.g. token pasted
      // manually instead of clicking the emailed link).
      const now = new Date();
      await prisma.invitationToken.update({
        where: { token },
        data: {
          used: true,
          registeredAt: now,
          verifiedAt: emailVerified ? now : undefined,
          // An email-less link learns its address here — from then on the
          // inviter's list shows who actually walked through it, and the
          // verify-email hook can find the row to stamp.
          ...(invitationEmail ? {} : { email }),
        },
      });
      // Backfill openedAt if the "opened" ping never landed (e.g. the token was
      // pasted manually instead of clicking the emailed link).
      await prisma.invitationToken.updateMany({
        where: { token, openedAt: null },
        data: { openedAt: now },
      });

      // "Click the link and you are connected" (#51): the invitation carries the
      // counterpart, so the mentorship (and the project membership) exist before
      // the invitee ever reaches their dashboard. Best-effort — a failure here
      // must not undo a valid registration, the account is already usable.
      try {
        const mentorId = role === 'MENTEE' ? autoLink.mentorId : null;
        const menteeId = role === 'MENTOR' ? autoLink.menteeId : null;
        const pair = mentorId
          ? { mentorId, menteeId: user.id }
          : menteeId
            ? { mentorId: user.id, menteeId }
            : null;
        if (pair) {
          const already = await prisma.mentorshipRelation.findFirst({ where: pair, select: { id: true } });
          if (!already) {
            await prisma.mentorshipRelation.create({ data: { ...pair, orgId: user.orgId } });
          }
          const counterpartId = pair.mentorId === user.id ? pair.menteeId : pair.mentorId;
          await notify(
            counterpartId,
            'mentorship.connected',
            { name: user.fullName },
            role === 'MENTEE' ? '/mentor/mentees' : '/admin/mentorship'
          );
        }
        if (autoLink.projectId) {
          await prisma.projectMember.upsert({
            where: { projectId_userId: { projectId: autoLink.projectId, userId: user.id } },
            update: {},
            create: {
              projectId: autoLink.projectId,
              userId: user.id,
              role: role === 'MENTEE' ? 'MENTEE' : 'MENTOR',
              functionalRole: role === 'MENTEE' ? 'DEVELOPER' : null,
            },
          });
          await createOrGetProjectConversation(autoLink.projectId);
        }
      } catch (e) {
        console.error('Invitation auto-link failed:', e);
      }

      // Email-less link: the address is unproven, so it gets the same
      // confirmation mail an open sign-up gets. Non-blocking — the account is
      // already active, verification only settles the mailbox.
      if (!emailVerified) {
        const verifyToken = await createEmailVerificationToken(user.id);
        try {
          await sendVerificationEmail({ to: user.email, token: verifyToken, fullName: user.fullName });
        } catch (e) {
          console.error('Verification email failed:', e);
        }
      }
    } else {
      const verifyToken = await createEmailVerificationToken(user.id);
      try {
        await sendVerificationEmail({ to: user.email, token: verifyToken, fullName: user.fullName });
      } catch (e) {
        console.error('Verification email failed:', e);
      }
      // Let admins know someone signed up. Under 'manual' they have to act;
      // under 'auto' it is an FYI — the account admits itself once verified.
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
      await Promise.all(
        admins.map((a) =>
          notify(a.id, pending ? 'signup.pendingApproval' : 'signup.new', { name: user.fullName }, '/admin/users')
        )
      );
    }

    // Duplicate post-check (#841): fire-and-forget — the registration already
    // succeeded, admins just get a heads-up to review /admin/duplicates.
    // Never surfaced in the public response.
    if (role === 'MENTEE') {
      void (async () => {
        const matches = await findPossibleDuplicates({
          orgId: user.orgId,
          excludeId: user.id,
          fullName,
          email,
        });
        if (matches.length === 0) return;
        const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
        await Promise.all(admins.map((a) => notify(a.id, 'duplicate.suspected', { name: fullName }, '/admin/duplicates')));
      })().catch((e) => console.error('Duplicate post-check failed:', e));
    }

    return NextResponse.json({ user, emailVerified, pending, selfRegistered }, { status: 201 });
  } catch (error) {
    console.error('Register error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
