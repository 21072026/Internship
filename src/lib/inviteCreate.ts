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
//
// Since #1863 the three steps are also exported separately —
// `persistInvitation` / `logInvitationCreated` / `deliverInvitation` — because
// the inquiry→company conversion has to mint its invitation INSIDE a
// `$prisma.transaction` alongside the Company it belongs to (an invitation to
// sign in to a company that failed to be created is worse than no invitation),
// and an SMTP round-trip has no business holding a database transaction open.
// `createInvitation` is still the one-call path and is exactly those three in
// order, so neither route grew a second copy of the mechanics.
import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
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
  /**
   * COMPANY is reachable only from the inquiry→company conversion (#1863):
   * `/api/invite` and the bulk board both validate against their own, narrower
   * enum, so no admin can mint a company login from the generic invite form
   * without a company to attach it to.
   */
  role: 'MENTOR' | 'MENTEE' | 'ADMIN' | 'COMPANY';
  /**
   * Which language the invitation mail is written in (#1720).
   *
   * The invitee has no account and therefore no `preferredLanguage`, and reading
   * Accept-Language is not available on a resend hours later — so the language
   * is the INVITER's decision: picked in the invite form, defaulting to their
   * own UI language. It is stored on the row so a resend (possibly by a
   * different admin, possibly from the bulk board) repeats the same language
   * instead of switching mid-conversation. Null → the deployment default.
   */
  locale?: string | null;
  mentorId?: string | null;
  menteeId?: string | null;
  projectId?: string | null;
  /**
   * The company an invited COMPANY user is attached to on registration (#1863).
   * Meaningless for any other role and simply carried through as null.
   */
  companyId?: string | null;
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

/** The persisted half of an invitation — no mail attempted yet. */
export interface PersistedInvitation {
  invitationId: string;
  token: string;
  /** The locale stamped on the row, which is what a resend must repeat. */
  locale: string | null;
}

/**
 * Write the InvitationToken row. The token, the 7-day expiry and every pointer
 * a registration later reads are decided here and nowhere else.
 *
 * `client` lets a caller run the insert inside its own interactive transaction
 * (#1863), so an invitation and the row it depends on either both exist or
 * neither does. Default: the ordinary client, i.e. today's behaviour.
 */
export async function persistInvitation(
  input: CreateInvitationInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<PersistedInvitation> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + INVITATION_TTL_DAYS);

  const invitation = await client.invitationToken.create({
    data: {
      token,
      email: input.email,
      label: input.label,
      role: input.role,
      expiresAt,
      locale: input.locale ?? null,
      invitedById: input.actor.id,
      orgId: input.orgId,
      mentorId: input.mentorId ?? null,
      menteeId: input.menteeId ?? null,
      projectId: input.projectId ?? null,
      companyId: input.companyId ?? null,
    },
    select: { id: true, locale: true },
  });

  return { invitationId: invitation.id, token, locale: invitation.locale };
}

/**
 * The audit entry for a minted invitation. Separate from `persistInvitation` so
 * a caller minting inside a transaction can log AFTER the commit — an
 * `invite.created` line for an invitation that was rolled back would be a lie
 * in the one record that is supposed to be trustworthy.
 */
export async function logInvitationCreated(
  input: CreateInvitationInput,
  invitationId: string,
): Promise<void> {
  await logActivity({
    action: 'invite.created',
    actorId: input.actor.id,
    actorEmail: input.actor.email ?? null,
    targetType: 'invitation',
    targetId: invitationId,
    detail: `${input.email ?? input.label ?? 'link'} · ${input.role}`,
    request: input.request,
  });
}

/**
 * Send the invitation mail for an already-persisted token. Never throws: the
 * token is live by the time this runs, so a blocked relay must cost at most the
 * mail, never the invitation.
 */
export async function deliverInvitation(
  input: Pick<CreateInvitationInput, 'email' | 'role' | 'orgId'>,
  persisted: PersistedInvitation,
): Promise<{ emailSent: boolean; mailError: unknown }> {
  if (!input.email) return { emailSent: false, mailError: null };
  try {
    // The transport reports what it did, so demo mode and an unconfigured
    // SMTP are honestly "not sent" rather than a guess about SMTP_USER.
    const result = await sendInvitationEmail({
      to: input.email,
      token: persisted.token,
      role: input.role,
      orgId: input.orgId,
      locale: persisted.locale,
    });
    return { emailSent: result === 'SENT', mailError: null };
  } catch (err) {
    console.error('Invitation email failed (token still valid):', err);
    return { emailSent: false, mailError: err };
  }
}

export async function createInvitation(input: CreateInvitationInput): Promise<CreatedInvitation> {
  const persisted = await persistInvitation(input);
  await logInvitationCreated(input, persisted.invitationId);
  const { emailSent, mailError } = await deliverInvitation(input, persisted);

  return {
    invitationId: persisted.invitationId,
    token: persisted.token,
    registerUrl: invitationRegisterUrl(persisted.token),
    emailSent,
    mailError,
  };
}

/**
 * Undo a `createInvitation` whose mail could not be handed to the transport.
 * Only the bulk path uses it: one paste of 300 addresses must not leave a
 * scatter of tokens nobody was told about.
 */
export async function discardInvitation(invitationId: string): Promise<void> {
  await prisma.invitationToken.delete({ where: { id: invitationId } }).catch(() => {});
}
