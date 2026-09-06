'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { roleHome } from '@/lib/roleHome';
import { reportBoundaryError } from '@/lib/reportBoundaryError';

/**
 * The body of every route-level `error.tsx` in the app (#1602).
 *
 * A segment's `error.tsx` renders *inside* the layouts above it, so the tree's
 * own chrome (sidebar, header, back link) is still on screen — this only has to
 * replace the page content. It also renders inside `Providers`, which is why
 * `useT()` and `useSession()` are available here but deliberately not in
 * `global-error.tsx`.
 *
 * What is NOT shown: the error message and the stack. A boundary is a
 * user-facing screen, and a server throw's message routinely carries query
 * fragments, ids and file paths. The digest is the one safe handle — it is the
 * hash Next.js also writes to the server log, so a person can quote it in a
 * report and it can be matched to the real error.
 */
export function RouteErrorBoundary({
  error,
  reset,
  homeHref,
  homeLabel,
  description,
  scope,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Where "back" goes — that tree's own landing page, never /admin. */
  homeHref: string;
  homeLabel?: string;
  /** Body copy, when the default "…back to the dashboard" is not true here. */
  description?: string;
  /** Route tree name, carried into the error report. */
  scope: string;
}) {
  const t = useT();

  useEffect(() => {
    reportBoundaryError(error, { scope, digest: error.digest });
  }, [error, scope]);

  return (
    <div className="flex items-center justify-center py-20" data-testid="route-error-boundary">
      <Card className="max-w-md w-full text-center">
        <AlertTriangle className="h-10 w-10 text-red-500 mx-auto mb-4" aria-hidden="true" />
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{t.errorBoundary.title}</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{description ?? t.errorBoundary.description}</p>
        {error.digest && (
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
            {t.errorBoundary.digest}{' '}
            <code className="font-mono" data-testid="route-error-digest">
              {error.digest}
            </code>
          </p>
        )}
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button onClick={reset} data-testid="route-error-retry">
            {t.errorBoundary.retry}
          </Button>
          <Button
            variant="outline"
            data-testid="route-error-home"
            onClick={() => {
              window.location.href = homeHref;
            }}
          >
            {homeLabel ?? t.errorBoundary.backHome}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * The same boundary for the trees that are shared by every role — /messages,
 * /todos, /notifications, /account, /interviews, /announcements, /newsletters,
 * /mentors, /projects. Their layouts already send "back" to `roleHome(role)`,
 * and this mirrors that from the client session so a mentee is never handed a
 * link to /admin (a 403 loop).
 *
 * With no session (the public /projects showcase) it falls back to the landing
 * page and says "back to home" rather than "back to dashboard".
 */
export function SharedRouteErrorBoundary({
  error,
  reset,
  scope,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  scope: string;
}) {
  const t = useT();
  const { data: session, status } = useSession();
  const role = session?.user?.role;
  // Only once next-auth has actually answered. `SessionProvider` starts in
  // `loading` and fetches /api/auth/session, so keying the copy off
  // `!session` alone would flash "back to home" at a signed-in user for as
  // long as that round trip takes. `/` is the right destination throughout —
  // it is where a signed-out visitor belongs and where a signed-in one gets
  // bounced to their own dashboard from — so only the wording waits.
  const signedOut = status === 'unauthenticated';

  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      scope={scope}
      homeHref={role ? roleHome(role) : '/'}
      homeLabel={signedOut ? t.notFound.backHome : t.errorBoundary.backHome}
      // "…or go back to the dashboard" is a promise a signed-out visitor on the
      // public /projects or /mentors pages cannot cash in.
      description={signedOut ? t.errorBoundary.descriptionPublic : undefined}
    />
  );
}
