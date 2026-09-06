'use client';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Error boundary for /source/*.
export default function SourceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary error={error} reset={reset} scope="source" homeHref="/source" />;
}
