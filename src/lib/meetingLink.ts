// Pure link helpers with no imports, kept apart from meetingContext.ts so
// client components can use them without dragging Prisma (or node:crypto) into
// the browser bundle. `generateMeetingLink` stays server-side in
// meetingRoom.ts for that reason.

// Hosts we are willing to put in an iframe. Must stay in sync with `frame-src`
// and the `Permissions-Policy` allowlist in next.config.js — widening one
// without the other yields an empty box or a call with no camera.
//
// `8x8.vc` is our JaaS tenant (#1237), used while the month's participant
// allowance has room for the call (see src/lib/meetingRoom.ts); `meet.jit.si`
// carries everything else — rooms created once the allowance is spent, links
// created before the JaaS switch, and environments with no JaaS credentials
// (local dev, CI).
export const EMBEDDABLE_MEETING_HOSTS = ['meet.jit.si', '8x8.vc'];

// The public Jitsi instance. Embeddable, free, needs no account — and it HANGS
// UP AN EMBEDDED CALL AFTER ABOUT FIVE MINUTES ("Embedding meet.jit.si is only
// meant for demo purposes"). The same room opened in a browser tab has no such
// limit, which is what makes the warning below actionable rather than an
// apology.
export const FREE_MEETING_HOST = 'meet.jit.si';

// True when the link can safely be embedded. Meet/Zoom/Teams all send
// X-Frame-Options and would render an empty box, so the UI has to offer
// "open in a new tab" for anything else.
export function isEmbeddableMeetingLink(link: string | null | undefined): boolean {
  if (!link) return false;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return EMBEDDABLE_MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * True when this link is a room on the public Jitsi instance — the host with
 * the five-minute embedded-call cutoff (#2011).
 *
 * Client-safe and deliberately host-shaped rather than "is this one of ours":
 * a link created months ago, before the JaaS tenant existed, is exactly as
 * cut-off-prone as one created a minute ago, and both must warn.
 */
export function isFreeInstanceMeetingLink(link: string | null | undefined): boolean {
  if (!link) return false;
  try {
    const host = new URL(link).hostname.toLowerCase();
    return host === FREE_MEETING_HOST || host.endsWith(`.${FREE_MEETING_HOST}`);
  } catch {
    return false;
  }
}

export interface JaasRoomRef {
  /** `vpaas-magic-cookie-…` */
  appId: string;
  /** Room name on its own, e.g. `InternshipCRM-1a2b…`. */
  room: string;
}

// Split a stored JaaS link back into the two parts the embed needs: the app id
// (which selects the tenant's `external_api.js`) and the room name (which the
// participant's token is scoped to).
//
// Strict on purpose, and used on the server too: the room name taken from here
// ends up inside a signed token and in a URL, so anything that is not one of our
// own generated links is rejected rather than passed along.
export function parseJaasMeetingLink(link: string | null | undefined): JaasRoomRef | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:') return null;
    if (url.hostname.toLowerCase() !== '8x8.vc') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const [appId, room] = parts;
    if (!appId.startsWith('vpaas-magic-cookie-')) return null;
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(room)) return null;
    return { appId, room };
  } catch {
    return null;
  }
}

// The uninterrupted-service escape hatch: a JaaS room name works verbatim on
// the free public instance, so from any of our own 8x8.vc links a working
// meet.jit.si link can be derived. The panel offers it when the JaaS call
// fails to start (tenant down, quota blocked, token rejected) — everyone who
// switches to it lands in the *same* room, because the name is the same.
//
// Deliberately built on parseJaasMeetingLink: a pasted Meet/Zoom/arbitrary
// URL yields null here, and only our own generated links get a fallback.
export function freeMeetingFallbackLink(link: string | null | undefined): string | null {
  const jaas = parseJaasMeetingLink(link);
  return jaas ? `https://meet.jit.si/${jaas.room}` : null;
}

// The product a link belongs to, for an "Open in <provider>" button (#2007).
// Nothing but a label: Meet/Zoom/Teams all refuse to be framed, so when the
// panel cannot show the room it should at least say where the room is. Known
// hosts get their brand name; anything else gets its hostname, which for a
// company's own instance (`video.acme.de`) is the name people know it by.
const MEETING_PROVIDERS: ReadonlyArray<readonly [host: string, name: string]> = [
  ['meet.google.com', 'Google Meet'],
  ['zoom.us', 'Zoom'],
  ['zoom.com', 'Zoom'],
  ['teams.microsoft.com', 'Microsoft Teams'],
  ['teams.live.com', 'Microsoft Teams'],
  ['webex.com', 'Webex'],
  ['whereby.com', 'Whereby'],
  ['meet.jit.si', 'Jitsi'],
  ['8x8.vc', 'Jitsi'],
];

// A Slack huddle is a product, not a host (#2879): `app.slack.com` also serves
// message permalinks and the workspace itself, so only the `/huddle/…` link of
// a channel gets the name. Anything else on that host falls through to the
// hostname like every unknown link. Deliberately NOT in EMBEDDABLE_MEETING_HOSTS:
// Slack refuses to be framed, and "Open in Slack Huddle" is the whole point.
export const SLACK_HUDDLE_PROVIDER = 'Slack Huddle';

export function meetingProviderName(link: string | null | undefined): string | null {
  if (!link) return null;
  let host: string;
  let path: string;
  try {
    const url = new URL(link);
    host = url.hostname.toLowerCase();
    path = url.pathname;
  } catch {
    return null;
  }
  if (!host) return null;
  if (host === 'app.slack.com' && /^\/huddle\/[^/]+\/[^/]+\/?$/.test(path)) return SLACK_HUDDLE_PROVIDER;
  for (const [known, name] of MEETING_PROVIDERS) {
    if (host === known || host.endsWith(`.${known}`)) return name;
  }
  return host;
}
