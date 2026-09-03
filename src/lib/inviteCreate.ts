// The one place an InvitationToken is minted (#2070).
//
// Before bulk invitations there was exactly one creation path — the body of
// POST /api/invite — and the bulk endpoint could have grown a second copy of
// it. It must not: the token/expiry, the tenant (`orgId`, #678), the
// auto-pairing pointers (`mentorId`/`menteeId`/`projectId`) and the mail
// template are all things a second copy would silently drift on. So the
// mechanics live here and both routes call this function; each route keeps
// its own *authorisation* and *validation*, which is where they legitimately
// differ (bulk refuses ADMIN, single does not).
//
// Mail never throws out of here: the token is already persisted when the send
// is attempted, so a blocked relay must not lose the invitation. The failure is
// handed back as `mailError` and the caller decides — the single invite reports
// "share the link manually", the bulk run rolls the row back so a paste never
// leaves a half-created invitation behind.
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { sendInvitationEmail } from '@/services/emailService';

export const INVITATION_TTL_DAYS = 7;

export interface CreateInvitationInput {
  /** Who is inviting — becomes `invitedById` (and the invitee's `referredById`). */
  actor: { id: string; email?: string | null };
  /** The inviter's tenant, from resolveOrgId(session). */
  orgId: string | null;
  /** null mints an email-less shareable link (#670); nothing is sent. */
  email: string | null;
  label: string | null;
  role: 'MENTOR' | 'MENTEE' | 'ADMIN';
  mentorId?: string | null;
  menteeId?: string | null;
  projectId?: string | null;
  /** Passed through to the activity log for IP/UA attribution. */
  request?: Request;
}

export interface CreatedInvitation {
  invitationId: string;
  token: string;
  registerUrl: string;
  /** True only for an actually delivered mail — a SKIPPED transport is false. */
  emailSent: boolean;
  /** Non-null when the transport threw; the token exists regardless. */
  mailError: unknown;
}

export function invitationRegisterUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return `${appUrl}/auth/register?token=${token}`;
}

export async function createInvitation(input: CreateInvitationInput): Promise<CreatedInvitation> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITATION_TTL_DAYS);

  const invitation = await prisma.invitationToken.create({
    data: {
      token,
      email: input.email,
      label: input.label,
      role: input.role,
      expiresAt,
      invitedById: input.actor.id,
      orgId: input.orgId,
      mentorId: input.mentorId ?? null,
      menteeId: input.menteeId ?? null,
      projectId: input.projectId ?? null,
    },
  });

  await logActivity({
    action: 'invite.created',
    actorId: input.actor.id,
    actorEmail: input.actor.email ?? null,
    targetType: 'invitation',
    targetId: invitation.id,
    detail: `${input.email ?? input.label ?? 'link'} · ${input.role}`,
    request: input.request,
  });

  let emailSent = false;
  let mailError: unknown = null;
  if (input.email) {
    try {
      // The transport reports what it did, so demo mode and an unconfigured
      // SMTP are honestly "not sent" rather than a guess about SMTP_USER.
      emailSent =
        (await sendInvitationEmail({ to: input.email, token, role: input.role, orgId: input.orgId })) === 'SENT';
    } catch (err) {
      mailError = err;
      console.error('Invitation email failed (token still valid):', err);
    }
  }

  return { invitationId: invitation.id, token, registerUrl: invitationRegisterUrl(token), emailSent, mailError };
}

/**
 * Undo a `createInvitation` whose mail could not be handed to the transport.
 * Only the bulk path uses it: one paste of 300 addresses must not leave a
 * scatter of tokens nobody was told about.
 */
export async function discardInvitation(invitationId: string): Promise<void> {
  await prisma.invitationToken.delete({ where: { id: invitationId } }).catch(() => {});
}
