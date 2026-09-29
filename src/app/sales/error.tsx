'use client';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Error boundary for /sales/* (#2580). The sales shell stays mounted above it;
// "back" goes to the sales dashboard.
export default function SalesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary error={error} reset={reset} scope="sales" homeHref="/sales" />;
}
