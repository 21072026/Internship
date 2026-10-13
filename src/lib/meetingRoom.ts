import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import {
  checkExternalMeetingLink,
  chooseMeetingLinkSource,
  conferencingPolicyOf,
  type ExternalLinkCheck,
  type ExternalLinkRefusal,
  type MeetingLinkSource,
} from '@/lib/conferencingRule';
import { servedHosts } from '@/lib/servedHosts';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { jaasConfig, jaasRoomUrl } from '@/lib/jaas';
import { jaasRoomAllowed, projectedHeadCount } from '@/lib/jaasAllowance';
import { recordVideoUsage } from '@/lib/metering';
import { prisma } from '@/lib/prisma';
import { productNameFor } from '@/lib/verticals';

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
//
// The prefix is the product of the organizer's world (docs/worlds.md): Jitsi
// shows the room name as the call title, so a SaleVali demo call must not read
// "InternshipCRM-…" to the customer. Omitted, it is the internship product —
// which is what every room was. Nothing parses the prefix back
// (parseJaasMeetingLink accepts any room name), so old rooms keep working.
export function generateMeetingRoomName(vertical?: unknown): string {
  const prefix = productNameFor(vertical).replace(/[^A-Za-z0-9]/g, '');
  return `${prefix}-${randomBytes(8).toString('hex')}`;
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
 * `vertical` is the organizer org's world and only picks the room-name prefix.
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
  vertical?: string | null;
}): string {
  const room = generateMeetingRoomName(opts.vertical);
  const config = opts.jaasAllowed ? jaasConfig() : null;
  // REPORTED, NEVER GATED. This is the tenant's own video volume (#1750), a
  // different question from the JaaS allowance above: one is "what did this
  // customer use?", the other is "what does 8x8 charge us for?". Both are
  // fire-and-forget and swallowed inside — a meter must not be able to fail a
  // call, and this function stays synchronous for its call sites.
  recordVideoUsage({ orgId: opts.orgId ?? null, inviteeCount: opts.inviteeCount });
  return config ? jaasRoomUrl(config, room) : `https://meet.jit.si/${room}`;
}

// ── Bring your own link (#2007) ──────────────────────────────────────────────

/**
 * The one validation every link a PERSON supplies goes through — a pasted
 * `meetLink`, a series' `fixedLink`, the saved personal room on /account. The
 * rule is `checkExternalMeetingLink` (lib/conferencingRule.ts, pure); this
 * binds it to this deployment's served hosts and to the width of the columns
 * the link is written to (Meeting.meetLink, MeetingSeries.fixedLink and
 * User.personalMeetingUrl are all VARCHAR(191) — `profileUrl` is that width).
 */
export function checkPastedMeetingLink(raw: string | null | undefined): ExternalLinkCheck {
  return checkExternalMeetingLink(raw, servedHosts(), TEXT_LIMITS.profileUrl);
}

export type MeetingLinkOutcome =
  | { ok: true; link: string; source: MeetingLinkSource }
  // A supplied link we will not send people to (http, credentials, our own
  // host, too long for the column). `reason` is the rule's word for why.
  | { ok: false; code: 'invalid_link'; reason: ExternalLinkRefusal }
  // The tenant's policy is REQUIRE_EXTERNAL and nothing external was offered:
  // no pasted link, no saved personal room.
  | { ok: false; code: 'external_link_required' };

/**
 * The HTTP answer to a refused outcome, so the four creation paths say the
 * same thing. 400 for a link that cannot be used as typed; 422 for a request
 * that is well-formed but needs a link the organiser has not given — the UI
 * reads `code` and says what to do (paste a link, or save a personal room).
 */
export function meetingLinkRefusal(outcome: Extract<MeetingLinkOutcome, { ok: false }>): NextResponse {
  if (outcome.code === 'invalid_link') {
    return NextResponse.json(
      { error: 'That meeting link cannot be used', code: 'invalid_link', reason: outcome.reason },
      { status: 400 },
    );
  }
  return NextResponse.json(
    {
      error: 'Your organization requires a meeting link from its own conferencing tool — paste one, or save a personal room on your account page',
      code: 'external_link_required',
    },
    { status: 422 },
  );
}

/**
 * THE entry point for every meeting-creation path: the link a meeting should
 * carry, in precedence order (the rule: lib/conferencingRule.ts).
 *
 *   1. `pastedLink` — an organiser who supplied their own room gets exactly
 *      that room, and nothing is generated or metered. Validated first: a
 *      link we would not send people to is refused, not stored.
 *   2. The organiser's saved personal room (`User.personalMeetingUrl`), when
 *      the tenant's `conferencingPolicy` is PREFER_PERSONAL or
 *      REQUIRE_EXTERNAL. A stored room that no longer passes the check (the
 *      served-host set can change between deployments) counts as absent.
 *   3. A room of ours — the JaaS tenant while the projected head-count fits
 *      the allowance, else the public instance — unless the policy is
 *      REQUIRE_EXTERNAL, which refuses instead of minting one.
 *
 * `organizerId` is whose saved room applies: the session user on the
 * schedule/instant/series paths, the relation's mentor when a request is
 * accepted (the call is the mentor's room, whoever clicked accept). Omitted,
 * step 2 is skipped. A provider-generated link (#2009) slots in between 2
 * and 3 when it lands.
 */
export async function resolveMeetingLink(opts: {
  inviteeCount: number | null;
  orgId?: string | null;
  organizerId?: string | null;
  pastedLink?: string | null;
}): Promise<MeetingLinkOutcome> {
  const pasted = opts.pastedLink?.trim();
  if (pasted) {
    const check = checkPastedMeetingLink(pasted);
    return check.ok
      ? { ok: true, link: check.url, source: 'pasted' }
      : { ok: false, code: 'invalid_link', reason: check.reason };
  }

  const [org, organizer] = await Promise.all([
    // `Organization` is not a tenant model; a failed read is the default world
    // on the default policy.
    opts.orgId
      ? prisma.organization
          .findUnique({ where: { id: opts.orgId }, select: { vertical: true, conferencingPolicy: true } })
          .catch(() => null)
      : null,
    opts.organizerId
      ? prisma.user
          .findUnique({ where: { id: opts.organizerId }, select: { personalMeetingUrl: true } })
          .catch(() => null)
      : null,
  ]);
  const policy = conferencingPolicyOf(org?.conferencingPolicy);
  const personalCheck = organizer?.personalMeetingUrl ? checkPastedMeetingLink(organizer.personalMeetingUrl) : null;
  const choice = chooseMeetingLinkSource({ policy, personal: personalCheck?.ok ? personalCheck.url : null });
  if ('refused' in choice) return { ok: false, code: choice.refused };
  if (choice.source === 'personal') return { ok: true, link: choice.link, source: 'personal' };

  const jaasAllowed = await jaasRoomAllowed(projectedHeadCount(opts.inviteeCount));
  return {
    ok: true,
    source: 'builtin',
    link: generateMeetingLink({
      inviteeCount: opts.inviteeCount,
      orgId: opts.orgId,
      jaasAllowed,
      vertical: org?.vertical ?? null,
    }),
  };
}
