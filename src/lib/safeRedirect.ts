'use client';

/**
 * The path to send a browser to after signing in, from a `?callbackUrl=` /
 * `?next=` parameter — or the fallback when that value is not somewhere on this
 * site (#1495).
 *
 * Resolved through the URL parser against our own origin rather than checked
 * with string prefixes. A hand-written `startsWith('/') && !startsWith('//')`
 * looks equivalent and is not: browsers normalise a backslash to a slash while
 * parsing, so `/\evil.example` passes that test and then navigates
 * cross-origin. Letting URL do the parsing means the check sees the same value
 * the browser will act on.
 */
export function sameOriginPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Not a URL at all — treat it like an absent parameter.
    return fallback;
  }
}
