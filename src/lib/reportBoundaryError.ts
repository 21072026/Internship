// Single funnel for errors that reach a React error boundary.
//
// Every route-level `error.tsx` (and the root `global-error.tsx`) calls this
// from its `useEffect` instead of a bare `console.error`, so that wiring the
// real error tracker (#1600) is one edit here rather than one edit per
// boundary. Until that lands this is a structured console line — the shape
// below is deliberately the payload a tracker would want.
//
// Client-side module on purpose: `lib/logger.ts` reads `process.env.LOG_LEVEL`,
// which the browser bundle has no value for.

export type BoundaryErrorContext = {
  /** Which boundary caught it — the route tree, or 'global' for the root shell. */
  scope: string;
  /** Next.js' server-side error digest, when the throw happened on the server. */
  digest?: string;
};

export function reportBoundaryError(error: unknown, context: BoundaryErrorContext) {
  const err = error instanceof Error ? error : new Error(String(error));
  const digest = context.digest ?? (err as Error & { digest?: string }).digest;

  // The message and stack stay in the console and the server log; none of this
  // is rendered to the user — RouteErrorBoundary shows the digest and nothing
  // else, so a stack trace can never end up on a mentee's screen.
  console.error('[boundary] ' + context.scope, {
    scope: context.scope,
    digest: digest ?? null,
    name: err.name,
    message: err.message,
    stack: err.stack,
    // Handy for correlating a report with what the person was actually doing.
    path: typeof window === 'undefined' ? null : window.location.pathname,
  });
}
