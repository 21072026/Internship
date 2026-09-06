'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// The newsletter archive is available to every authenticated role.
export default function NewslettersError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="newsletters" />;
}
