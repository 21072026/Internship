// The customer-mail lock of the marketing product (docs/mail-queue.md
// § The customer-mail lock).
//
// WHY. The marketing product is in its test phase: no lead, customer or
// contact of a MARKETING organization may receive ANY mail from this
// deployment — not a campaign, not a reminder, not a "system" mail (a password
// link, an invitation, a consent confirmation). Only the organization's own
// staff (ADMIN / MENTOR) still get theirs: they test the product.
//
// HOW IT IS SWITCHED. On by default, for every MARKETING organization; there
// is no in-app switch on purpose, so no click — an admin's, a test's, a
// script's — can open it. It opens only when the operator sets
// `MARKETING_CUSTOMER_MAIL_ENABLED=1` on the server. The internship product is
// never affected.
//
// ZERO imports: the decision is unit-tested (scripts/test/customer-mail-lock.test.mjs);
// the lookups that feed it live in src/lib/customerMailLock.ts, and the three
// places that ask it are the only doors a mail has (sendEmail(), an approved
// draft's sendPrepared(), the mail queue's drain).

export type LockRecipientKind = 'staff' | 'lead' | 'customer' | 'contact' | 'other';

/** The operator's switch. Anything but an explicit "1"/"true" keeps the lock on. */
export function customerMailUnlocked(env: Record<string, string | undefined>): boolean {
  const v = (env.MARKETING_CUSTOMER_MAIL_ENABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

export function recipientKindOfRole(role: string | null | undefined): LockRecipientKind {
  if (role === 'ADMIN' || role === 'MENTOR') return 'staff';
  if (role === 'MENTEE') return 'lead';
  if (role === 'COMPANY') return 'customer';
  return 'other';
}

export interface LockFacts {
  /** The vertical of the organization the recipient belongs to (null: none found). */
  vertical: string | null;
  kind: LockRecipientKind;
}

/**
 * Is this one recipient locked? Only in a MARKETING organization, and only a
 * recipient who is not its staff. A recipient the lookups could not place in
 * any organization is NOT a marketing recipient and is not locked here.
 */
export function recipientLocked(facts: LockFacts, unlocked: boolean): boolean {
  if (unlocked) return false;
  if (facts.vertical !== 'MARKETING') return false;
  return facts.kind !== 'staff';
}

/** The EmailLog reason a locked mail is recorded with. */
export const CUSTOMER_MAIL_LOCK_REASON = 'Customer mail locked (marketing test phase)';
