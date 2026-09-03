// Invitation lifecycle → one derived status (#2071).
//
// `InvitationToken` records the whole lifecycle in separate nullable columns
// (openedAt / registeredAt / verifiedAt / revokedAt, plus `used` and
// `expiresAt`). Every surface that wants to say "what happened to this
// invitation?" — the badge on the board, the status filter, the per-status
// counts and the CSV export — reads it through THIS module, so they can never
// disagree about what "expired" means.
//
// Deliberately dependency-free (no Prisma types, no server imports) so the
// client page and the route handlers share the same code, and so `Date | string`
// is accepted on both sides of the JSON boundary.

export const INVITATION_STATUSES = ['sent', 'opened', 'registered', 'verified', 'expired', 'revoked'] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** The lifecycle columns the derivation reads — nothing else is needed. */
export interface InvitationLifecycle {
  used: boolean;
  expiresAt: Date | string;
  openedAt: Date | string | null;
  registeredAt: Date | string | null;
  verifiedAt: Date | string | null;
  revokedAt: Date | string | null;
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * The single derivation, most-decisive state first:
 *
 *   revoked    — withdrawn by an admin; the token is refused at registration.
 *   verified   — the account exists and its address is confirmed.
 *   registered — the account exists but the address is not confirmed yet.
 *   expired    — never registered and past `expiresAt`.
 *   opened     — the register link was clicked, nothing more.
 *   sent       — minted, nothing has happened.
 *
 * `registered`/`verified` outrank `expired` on purpose: an invitation that was
 * consumed did its job, and the expiry stamp it carries afterwards is noise.
 * `revoked` outranks even those so an admin can see they withdrew something too
 * late — the row still says what happened rather than silently disappearing.
 */
export function deriveInvitationStatus(
  invitation: InvitationLifecycle,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.revokedAt) return 'revoked';
  if (invitation.verifiedAt) return 'verified';
  if (invitation.registeredAt || invitation.used) return 'registered';
  if (toTime(invitation.expiresAt) < now.getTime()) return 'expired';
  if (invitation.openedAt) return 'opened';
  return 'sent';
}

/** Statuses a bulk re-invite may touch: nobody has walked through the door yet. */
const RESENDABLE: ReadonlySet<InvitationStatus> = new Set<InvitationStatus>(['sent', 'opened', 'expired']);

/**
 * Can this invitation be re-sent? An already-registered (or verified) row is
 * refused — re-mailing "please join" to somebody who joined last week is the
 * fastest way to lose the sender domain's reputation — and so is a revoked one,
 * whose token no longer works at all.
 */
export function isInvitationResendable(status: InvitationStatus): boolean {
  return RESENDABLE.has(status);
}

/** Revoking is only meaningful while the token could still be redeemed. */
export function isInvitationRevocable(status: InvitationStatus): boolean {
  return RESENDABLE.has(status);
}

/**
 * Deleting drops the audit trail with the row, so it is limited to invitations
 * nobody ever touched: no open, no registration. A revoked-but-never-opened row
 * still qualifies — there is nothing to remember about it.
 */
export function isInvitationDeletable(invitation: Pick<InvitationLifecycle, 'openedAt' | 'registeredAt'>): boolean {
  return !invitation.openedAt && !invitation.registeredAt;
}

/** Zeroed counts for every status — the shape the board's summary row expects. */
export function emptyInvitationCounts(): Record<InvitationStatus, number> {
  return { sent: 0, opened: 0, registered: 0, verified: 0, expired: 0, revoked: 0 };
}

/** Per-status counts over a set of invitations, using the one derivation above. */
export function countInvitationStatuses(
  invitations: InvitationLifecycle[],
  now: Date = new Date(),
): Record<InvitationStatus, number> {
  const counts = emptyInvitationCounts();
  for (const invitation of invitations) counts[deriveInvitationStatus(invitation, now)]++;
  return counts;
}

/** Narrow an arbitrary query-string value to a status, or null. */
export function parseInvitationStatus(value: string | null | undefined): InvitationStatus | null {
  return value && (INVITATION_STATUSES as readonly string[]).includes(value) ? (value as InvitationStatus) : null;
}

// Synthetic address domains used by the demo/sample seeders. A bulk re-invite
// walks a list the admin did not hand-pick, so it must never turn the demo data
// into outbound mail — the addresses are fake, every send bounces, and bounces
// are what gets a sending domain blocked. Single-row resend (/api/invite/[id])
// is a deliberate one-off and is left alone.
const SYNTHETIC_EMAIL_DOMAINS = ['@demo.example.com', '@sample.invalid'] as const;

export function isSyntheticInviteEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  return SYNTHETIC_EMAIL_DOMAINS.some((domain) => lower.endsWith(domain));
}
