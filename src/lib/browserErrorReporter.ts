// The browser half of the error tracker (#1600). Client-only, dependency-free
// except the shared masking rule.
//
// The browser never talks to the tracker: it POSTs to our own
// `/api/telemetry/errors`, which re-scrubs, stamps role/org from the session and
// forwards through `lib/errorTracking.ts`. So the DSN stays a server secret, the
// CSP needs no new `connect-src` host, and an ad blocker that drops tracker
// hosts drops nothing.
//
// OFF unless the build was made with NEXT_PUBLIC_ERROR_TRACKING=1 (inlined at
// build time): no listener, no request. Signed-out visitors are not reported —
// the relay requires a session, and the landing page is not worth an
// anonymous write endpoint.

import { maskText, maskUrl } from './feedbackContext';

const MAX_PER_PAGE = 10;
const sent = new Set<string>();

export function browserErrorTrackingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ERROR_TRACKING === '1';
}

export function reportBrowserError(error: unknown, context: { scope: string; digest?: string } = { scope: 'window' }) {
  if (!browserErrorTrackingEnabled() || typeof window === 'undefined') return;
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-Error thrown');
  const payload = {
    name: maskText(err.name || 'Error', 64),
    // Masked here already so the address never leaves the browser; the relay masks again.
    message: maskText(err.message.split('\n', 1)[0], 300),
    stack: err.stack ? maskText(err.stack, 4000) : undefined,
    scope: context.scope,
    digest: context.digest ?? (err as Error & { digest?: string }).digest,
    path: maskUrl(window.location.pathname + window.location.search),
  };
  const key = `${payload.name}|${payload.message}|${payload.stack?.slice(0, 200) ?? ''}`;
  if (sent.has(key) || sent.size >= MAX_PER_PAGE) return;
  sent.add(key);
  try {
    void fetch('/api/telemetry/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => {});
  } catch {
    // Reporting must never be the second error on the page.
  }
}
