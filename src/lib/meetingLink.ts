// Pure link helpers with no imports, kept apart from meetingContext.ts so
// client components can use them without dragging Prisma (or node:crypto) into
// the browser bundle. `generateMeetingLink` stays server-side in
// meetingContext.ts for that reason.

// Hosts we are willing to put in an iframe. Must stay in sync with `frame-src`
// and the `Permissions-Policy` allowlist in next.config.js — widening one
// without the other yields an empty box or a call with no camera.
export const EMBEDDABLE_MEETING_HOSTS = ['meet.jit.si'];

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
