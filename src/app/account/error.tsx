'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// /account is reachable by every role, so "back" follows the session's own
// landing page rather than a fixed one.
export default function AccountError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="account" />;
}
