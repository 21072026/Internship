// Bring your own link (#2007) — the rule, with ZERO imports so it runs under
// `node --test --experimental-strip-types` (scripts/test/conferencing-rule.test.mjs)
// and in the browser alike. The database-aware half is `resolveMeetingLink` in
// src/lib/meetingRoom.ts, which is the one entry point every meeting-creation
// path uses; the UI reads `meetingProviderName` from src/lib/meetingLink.ts.
//
// Three levels decide which room a meeting gets, in this order:
//
//   1. a link the organiser PASTED into the form               (always wins)
//   2. the organiser's SAVED personal room  (User.personalMeetingUrl)
//      — when the tenant's policy is PREFER_PERSONAL or REQUIRE_EXTERNAL
//   3. a room of ours (JaaS tenant or the public instance)
//      — unless the policy is REQUIRE_EXTERNAL, which refuses instead
//
// BUILTIN stays the default and ignores a saved room on purpose: the tenant has
// not opted into other people's rooms, and today's behaviour must not change
// under anyone's feet. REQUIRE_EXTERNAL is the "our IT forbids third-party
// rooms" answer; it still uses a saved personal room, because that IS a link
// the organiser supplied, and because the instant-meeting and accept-a-request
// paths have no paste box — without the saved room they would be dead ends.
//
// Video is in the free-forever core. Nothing here can take a working call away
// from a participant: a policy restricts which rooms an ORGANISATION's own
// organisers hand out, and the one refusal it can produce says exactly what is
// missing and who can fix it (the organiser, with a link).

export const CONFERENCING_POLICIES = ['BUILTIN', 'PREFER_PERSONAL', 'REQUIRE_EXTERNAL'] as const;
export type ConferencingPolicyKey = (typeof CONFERENCING_POLICIES)[number];

/** A stored or posted value → a policy; anything unknown reads as BUILTIN. */
export function conferencingPolicyOf(raw: unknown): ConferencingPolicyKey {
  return typeof raw === 'string' && (CONFERENCING_POLICIES as readonly string[]).includes(raw)
    ? (raw as ConferencingPolicyKey)
    : 'BUILTIN';
}

// ── Validating a link somebody typed ─────────────────────────────────────────

export type ExternalLinkRefusal =
  | 'invalid' // not a URL at all
  | 'not_https' // http:, a custom scheme, javascript: …
  | 'credentials' // user:pass@ in the authority
  | 'own_host' // points back at a host this deployment serves
  | 'too_long'; // would not fit the column it is written to

export type ExternalLinkCheck = { ok: true; url: string } | { ok: false; reason: ExternalLinkRefusal };

/**
 * Is `raw` a link we are willing to send people to? https only, no embedded
 * credentials, and never one of OUR hosts: a meeting link in an e-mail we send
 * that points back at interncrm.com/… is an open-redirect-shaped phishing gift,
 * and a room of ours is never something a person needs to paste.
 *
 * `ownHosts` is `servedHosts()` on the server (exact hostnames, no wildcard —
 * the same set every redirect is checked against, src/lib/servedHosts.ts).
 * `maxLength` is the width of the column the link ends up in (Meeting.meetLink
 * and User.personalMeetingUrl are VARCHAR(191)); a longer link would otherwise
 * surface as a Prisma P2000 500 at write time rather than a 400 here.
 *
 * Deliberately NOT a DNS/SSRF check (src/lib/ssrfGuard.ts): the server never
 * fetches this URL, people do, so a private address is their own business.
 */
export function checkExternalMeetingLink(
  raw: string | null | undefined,
  ownHosts: Iterable<string>,
  maxLength: number,
): ExternalLinkCheck {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  if (trimmed.length > maxLength) return { ok: false, reason: 'too_long' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, reason: 'invalid' };
  for (const own of ownHosts) {
    if (own && host === own.toLowerCase()) return { ok: false, reason: 'own_host' };
  }
  // The string as typed, not `url.href`: a normalised form can differ from
  // what the organiser sees on their own calendar invite.
  return { ok: true, url: trimmed };
}

// ── Choosing the source ──────────────────────────────────────────────────────

export type MeetingLinkSource = 'pasted' | 'personal' | 'builtin';

export type MeetingLinkChoice =
  | { source: 'pasted' | 'personal'; link: string }
  | { source: 'builtin' }
  | { refused: 'external_link_required' };

/**
 * The precedence above, as a function of what is known: the policy, a pasted
 * link (already validated, or empty) and the organiser's saved room (already
 * validated, or null). Pure; the caller mints the built-in room.
 */
export function chooseMeetingLinkSource(input: {
  policy: ConferencingPolicyKey;
  pasted?: string | null;
  personal?: string | null;
}): MeetingLinkChoice {
  const pasted = input.pasted?.trim();
  if (pasted) return { source: 'pasted', link: pasted };
  const personal = input.personal?.trim();
  if (personal && input.policy !== 'BUILTIN') return { source: 'personal', link: personal };
  if (input.policy === 'REQUIRE_EXTERNAL') return { refused: 'external_link_required' };
  return { source: 'builtin' };
}
