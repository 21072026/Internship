'use client';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Error boundary for /portal/*. "Back" goes to the mentee portal — sending a
// mentee to /admin would be a 403 loop.
export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary error={error} reset={reset} scope="portal" homeHref="/portal" />;
}
