import { isPendingActivation, isPlaceholderEmail, isErasedAccount } from '@/lib/menteeAccount';

/**
 * Why an account can't be reached (#1194).
 *
 * `isActive=false` was rendered as a single "Inactive" badge, which collapsed
 * five very different situations into one word. That ambiguity had a real cost:
 * a batch of sign-ups sat unreachable for days while it looked like the people
 * behind them were ignoring their messages. Each state below needs a different
 * action from the admin, so the UI has to tell them apart.
 *
 *  - `active`             — normal, can sign in.
 *  - `unverified`         — self-registered, never clicked the emailed link.
 *                           Action: resend the verification email.
 *  - `pending_approval`   — waiting on a human (`selfRegistration: 'manual'`).
 *                           Action: approve.
 *  - `deactivated`        — an admin turned a working account off.
 *                           Action: reactivate.
 *  - `no_login`           — a record a mentor/import created; it has no password
 *                           and can never sign in. Action: set a real address
 *                           and invite (PATCH /api/mentor/mentees/[id]).
 *  - `placeholder_email`  — same, and the address is a generated stand-in on a
 *                           domain that does not exist, so every mail to it is
 *                           discarded. Strictly worse than `no_login`, so it
 *                           wins when both apply.
 *  - `erased`             — anonymised by account erasure; not a live person.
 */
export type AccountState =
  | 'active'
  | 'unverified'
  | 'pending_approval'
  | 'deactivated'
  | 'no_login'
  | 'placeholder_email'
  | 'erased';

export interface AccountStateInput {
  isActive: boolean;
  emailVerified: boolean;
  pendingApproval: boolean;
  email: string;
  // Only present on server-side callers that select it; the value never leaves
  // the server — routes derive the state and drop the column from the response.
  password?: string;
}

export function accountState(user: AccountStateInput): AccountState {
  if (isErasedAccount(user)) return 'erased';
  // Checked before the isActive branches: a record with a stand-in address is
  // unreachable no matter what the flags say, and "resend the email" would be
  // actively misleading advice for it.
  if (isPlaceholderEmail(user.email)) return 'placeholder_email';
  if (user.password !== undefined && isPendingActivation({ password: user.password })) return 'no_login';
  if (user.isActive) return 'active';
  if (user.pendingApproval) return 'pending_approval';
  if (!user.emailVerified) return 'unverified';
  return 'deactivated';
}

/** Would a verification email to this account actually be useful? */
export function canResendVerification(state: AccountState): boolean {
  return state === 'unverified';
}

/** Can this person read an in-app message we send them? */
export function canReceiveInApp(state: AccountState): boolean {
  return state === 'active';
}

/** Is there a real mailbox behind this account? */
export function hasReachableEmail(state: AccountState): boolean {
  return state !== 'placeholder_email' && state !== 'erased';
}
