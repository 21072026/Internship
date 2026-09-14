import { randomBytes } from 'crypto';
import { jaasConfig, jaasRoomUrl } from '@/lib/jaas';
import { jaasRoomAllowed, projectedHeadCount } from '@/lib/jaasAllowance';
import { recordVideoUsage } from '@/lib/metering';

// Where a meeting's video room comes from. Server-only (node:crypto); the
// client-side link *checks* live in @/lib/meetingLink so components can import
// them without pulling crypto into the browser bundle.
//
// This used to be three copies of the same template literal (instant meetings,
// accepted meeting requests, recurring series). They are one function now
// because the JaaS/free-instance choice below has to apply to all of them.

// The room name, without a host. Unguessable on purpose: the room is the only
// thing protecting a call on the public instance, and on JaaS it is what the
// participant's token is scoped to.
export function generateMeetingRoomName(): string {
  return `InternshipCRM-${randomBytes(8).toString('hex')}`;
}

// ── The routing rule (#2011) ─────────────────────────────────────────────────
//
// A room goes to the JaaS tenant when the tenant is configured AND the room's
// projected head-count still fits inside the monthly-active-participant
// allowance we count ourselves (lib/jaasAllowance.ts). Otherwise it goes to
// `https://meet.jit.si/<room>` — and the UI says so before anyone joins.
//
//   pasted link              → used verbatim; we generate nothing
//   tenant + headroom        → https://8x8.vc/<appId>/<room>
//   anything else            → https://meet.jit.si/<room>  + the panel warning
//
// WHAT THIS REPLACED, AND WHY. The rule used to be `inviteeCount === 1`: the
// tenant was reserved for one-on-one calls because JaaS meters distinct
// participants per month and we had no way to see how much of that allowance
// was left. That guess had a price, and groups paid it — the public instance
// HANGS UP AN EMBEDDED CALL AFTER ABOUT FIVE MINUTES, so every project meeting,
// every bulk schedule and (via `inviteeCount: null`) every recurring series was
// routed, by construction, to a host that breaks the meeting. A team standup
// that dies at minute five is not a cheaper call; it is a broken one.
//
// Now the allowance is a number we compute from our own webhook feed, so the
// choice is evidence rather than a proxy. Two consequences, both deliberate:
//
//   · A group room MAY use the tenant. That is the fix — the public instance
//     stops being the automatic answer for groups.
//   · A 1:1 room may NOT, once the month is spent. It degrades to the public
//     instance with the same warning shown to a group — an announced
//     limitation, never a call that fails to start. Nothing here can refuse to
//     create a room: video is part of the free-forever core, and the worst case
//     is a link anybody can still open in a browser tab (where, unlike the
//     embedded panel, there is no five-minute cutoff).
//
// The free instance is also what local dev, CI and every e2e run get: they have
// no JaaS credentials, so `jaasRoomAllowed` answers false without a query. The
// runtime counterpart (an existing 8x8.vc room failing to start) is handled
// client-side via freeMeetingFallbackLink in @/lib/meetingLink.

/**
 * The synchronous half: mint a room on the host the caller has already decided
 * on. `jaasAllowed` comes from `resolveMeetingLink` below, which is the entry
 * point every creation path should use.
 *
 * Omitting `jaasAllowed` means the public instance. That default is the safe
 * direction — a caller that has not asked whether the allowance has room cannot
 * spend it — and it keeps this function pure and testable without a database.
 *
 * `orgId` is metering only (#1750) and changes nothing about the link: this is
 * the one chokepoint every room creation passes through, so it is the only
 * place where "how much video did this tenant use?" can be answered without
 * guessing. Optional, because a caller with no resolvable tenant still gets a
 * room — an unattributed room is simply not counted, never refused.
 */
export function generateMeetingLink(opts: {
  inviteeCount: number | null;
  orgId?: string | null;
  jaasAllowed?: boolean;
}): string {
  const room = generateMeetingRoomName();
  const config = opts.jaasAllowed ? jaasConfig() : null;
  // REPORTED, NEVER GATED. This is the tenant's own video volume (#1750), a
  // different question from the JaaS allowance above: one is "what did this
  // customer use?", the other is "what does 8x8 charge us for?". Both are
  // fire-and-forget and swallowed inside — a meter must not be able to fail a
  // call, and this function stays synchronous for its call sites.
  recordVideoUsage({ orgId: opts.orgId ?? null, inviteeCount: opts.inviteeCount });
  return config ? jaasRoomUrl(config, room) : `https://meet.jit.si/${room}`;
}

/**
 * THE entry point for every meeting-creation path: the link a meeting should
 * carry, in precedence order.
 *
 *   1. `pastedLink` — an organiser who supplied their own room gets exactly
 *      that room, and nothing is generated or metered. (The four routes already
 *      preferred a supplied `meetLink`; the precedence lives here now so there
 *      is one place to extend when a saved personal room and an org
 *      conferencing policy land — #2007 — and a provider-generated link after
 *      that — #2009.)
 *   2. The JaaS tenant, while the projected head-count fits the allowance.
 *   3. The public instance.
 */
export async function resolveMeetingLink(opts: {
  inviteeCount: number | null;
  orgId?: string | null;
  pastedLink?: string | null;
}): Promise<string> {
  const pasted = opts.pastedLink?.trim();
  if (pasted) return pasted;
  const jaasAllowed = await jaasRoomAllowed(projectedHeadCount(opts.inviteeCount));
  return generateMeetingLink({ inviteeCount: opts.inviteeCount, orgId: opts.orgId, jaasAllowed });
}
