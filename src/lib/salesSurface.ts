// The MARKETING sales surface (#2580).
//
// THE DECISION (maintainer, 2026-09-29, option (b) on #2580): a sales rep is
// invited as a MENTOR — the Role enum stays frozen — and in a vertical without
// the `mentorship` module that MENTOR gets a role-scoped working surface at
// `/sales` instead of being parked on `/account` (#2351's terminal redirect).
//
// WHICH CAPABILITY OPENS IT. Not `mentorship`: MARKETING must never carry that
// module (it would switch on the mentee portal, the mentor shell's mentorship
// pages and every #2352-gated write). The surface is the pipeline seen by its
// owner, so it is opened by `pipeline` — which every vertical carries — and it
// exists only where the mentor shell does NOT (`mentorship` absent). That second
// half is what keeps INTERNSHIP byte-identical: an INTERNSHIP mentor never sees
// `/sales` (the layout sends them back to `/mentor`) and the mentor shell's
// redirect branch that points here never runs for a vertical with mentorship.
//
// WHO. A MENTOR only. The leads of a MARKETING tenant are MENTEE rows (the
// person on the record, not an operator) and a COMPANY user is the customer:
// both keep landing on `/account`. An ADMIN has the whole admin shell and never
// needs this one.
//
// Pure and dependency-free (type import only), so the unit runner can load it.

import type { VerticalCapability } from '@/lib/verticals';
import type { AttentionReason } from '@/lib/mentorAttention';

export const SALES_HOME = '/sales';

/**
 * The role-neutral terminal page (#2351). Every authenticated role renders it
 * and it redirects no one, so it breaks any redirect loop.
 */
export const NEUTRAL_HOME = '/account';

/** Whether this role, in a vertical carrying `capabilities`, works on `/sales`. */
export function hasSalesSurface(role: string | null | undefined, capabilities: readonly VerticalCapability[]): boolean {
  return role === 'MENTOR' && capabilities.includes('pipeline') && !capabilities.includes('mentorship');
}

/**
 * Where the mentor shell sends a user whose vertical has no `mentorship`
 * module: the sales surface for a MENTOR that has one, the neutral page for
 * everyone else (an ADMIN in mentor mode, a dual-role MENTEE).
 */
export function mentorlessShellTarget(role: string | null | undefined, capabilities: readonly VerticalCapability[]): string {
  return hasSalesSurface(role, capabilities) ? SALES_HOME : NEUTRAL_HOME;
}

/**
 * The attention reasons that mean something on a sales record. The rest of
 * `AttentionReason` is mentorship work — an unanswered mentee question, a
 * meeting request, an open goal, weekly reports — or, for `inactive`, a
 * "no contact in N days" rule that would put most of a sales book in the queue
 * at once. `satisfies` makes a typo a type error.
 */
export const SALES_ATTENTION_REASONS = [
  'overdue',
  'trial_expired',
  'trial_no_end_date',
  'next_action_due',
] as const satisfies readonly AttentionReason[];
