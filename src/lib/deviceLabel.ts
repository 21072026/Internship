/**
 * "Chrome on Android" from a user-agent string.
 *
 * Shared by the two device lists on /account — the remembered browsers of
 * "keep me signed in" (#1495) and the browsers holding a push subscription
 * (#1716). One table rather than two: a person recognises their own devices by
 * the same words in both lists, and a second copy of these regexes would drift.
 *
 * Deliberately a small allowlist rather than a UA-parsing dependency: a wrong
 * guess costs a slightly odd label, never access. The stored user-agent is
 * untrusted free text — nothing outside this module ever renders it, so the UI
 * can only ever show one of the strings composed here.
 *
 * Pure and dependency-free on purpose (no prisma, no `next/headers`), so a
 * route handler, a client component and a plain unit test can all import it.
 */

const UA_MAX = 512;

export function deviceLabel(userAgent?: string | null): string | null {
  const ua = (userAgent || '').slice(0, UA_MAX);
  if (!ua) return null;
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os;
}
