// The invitation funnel (#1921): sent → opened → registered → activated.
//
// Pure and client-safe, like invitationStatus.ts beside it: the route, the
// registry report and the unit test read one rule. Every signal is an in-app
// event — no mail pixel, no tracking link:
//
//   opened     — the register link was opened (`openedAt`, POST /api/invite/opened).
//   registered — an account was created from it (`registeredAt`, or `used` on
//                rows from before the column).
//   activated  — that account has signed in at least once (`User.lastLoginAt`).
//                Registration sends the invitee to the sign-in page, so this is
//                the first real sign-in, not the registration itself.
//
// Two rules keep the numbers honest:
//
//   · The stages are CUMULATIVE. A later stage implies every earlier one, so a
//     registered invitation whose open was never stamped (the opened call is
//     best-effort) still counts as opened, and a stage can never exceed the one
//     before it.
//   · A REVOKED invitation that never registered leaves the funnel. The admin
//     withdrew it (a typo, the wrong person); counting it as "sent, not opened"
//     would read as an invitee who walked away. It is reported on its own.
//
// Counts and rates only, per role at the finest: no per-person list, neither of
// invitees nor of the staff who sent the invitations.

export const INVITATION_FUNNEL_STAGES = ['sent', 'opened', 'registered', 'activated'] as const;
export type InvitationFunnelStage = (typeof INVITATION_FUNNEL_STAGES)[number];

export type FunnelCounts = Record<InvitationFunnelStage, number>;

/** What the funnel reads of one invitation. `activated` is resolved by the loader. */
export interface FunnelInvitation {
  role: string;
  openedAt: Date | string | null;
  registeredAt: Date | string | null;
  used: boolean;
  revokedAt: Date | string | null;
  activated: boolean;
}

export interface InvitationFunnel {
  total: FunnelCounts;
  byRole: ({ role: string } & FunnelCounts)[];
  /** Withdrawn before anyone registered: outside the funnel, counted here. */
  revoked: number;
}

export const emptyFunnelCounts = (): FunnelCounts => ({ sent: 0, opened: 0, registered: 0, activated: 0 });

/** How far one invitation got, or null when it is not in the funnel (revoked unused). */
export function reachedStage(inv: FunnelInvitation): InvitationFunnelStage | null {
  const registered = !!inv.registeredAt || inv.used;
  if (inv.revokedAt && !registered) return null;
  if (registered && inv.activated) return 'activated';
  if (registered) return 'registered';
  if (inv.openedAt) return 'opened';
  return 'sent';
}

function add(counts: FunnelCounts, stage: InvitationFunnelStage): void {
  // Cumulative: reaching a stage counts in it and in every stage before it.
  for (const s of INVITATION_FUNNEL_STAGES) {
    counts[s]++;
    if (s === stage) return;
  }
}

/** The whole funnel, and per role, busiest first. */
export function invitationFunnel(rows: readonly FunnelInvitation[]): InvitationFunnel {
  const total = emptyFunnelCounts();
  const roles = new Map<string, FunnelCounts>();
  let revoked = 0;
  for (const inv of rows) {
    const stage = reachedStage(inv);
    if (!stage) {
      revoked++;
      continue;
    }
    add(total, stage);
    if (!roles.has(inv.role)) roles.set(inv.role, emptyFunnelCounts());
    add(roles.get(inv.role)!, stage);
  }
  const bySent = (a: FunnelCounts, b: FunnelCounts) => b.sent - a.sent;
  return {
    total,
    byRole: [...roles].map(([role, c]) => ({ role, ...c })).sort(bySent),
    revoked,
  };
}

/** Share of `part` in `whole` as a whole percent, or null when there is nothing to divide. */
export function funnelRate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}
