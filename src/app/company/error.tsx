'use client';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Error boundary for /company/*.
export default function CompanyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary error={error} reset={reset} scope="company" homeHref="/company" />;
}
