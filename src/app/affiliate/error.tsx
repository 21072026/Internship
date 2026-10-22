'use client';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Error boundary for /affiliate/*.
export default function AffiliateError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary error={error} reset={reset} scope="affiliate" homeHref="/affiliate" />;
}
