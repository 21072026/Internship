// Pure link helpers with no imports, kept apart from meetingContext.ts so
// client components can use them without dragging Prisma (or node:crypto) into
// the browser bundle. `generateMeetingLink` stays server-side in
// meetingRoom.ts for that reason.

// Hosts we are willing to put in an iframe. Must stay in sync with `frame-src`
// and the `Permissions-Policy` allowlist in next.config.js — widening one
// without the other yields an empty box or a call with no camera.
//
// `8x8.vc` is our JaaS tenant (#1237), used for one-on-one calls when
// configured; `meet.jit.si` carries everything else — group/bulk meetings and
// recurring series (JaaS bills per monthly active user, so the tenant is
// reserved for 1:1 calls — see src/lib/meetingRoom.ts), links created before
// the JaaS switch, and environments with no JaaS credentials (local dev, CI).
export const EMBEDDABLE_MEETING_HOSTS = ['meet.jit.si', '8x8.vc'];

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
