'use client';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Error boundary for /mentor/*. MentorLayout (sidebar, header) stays mounted
// above it; "back" goes to the mentor dashboard, not /admin.
export default function MentorError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary error={error} reset={reset} scope="mentor" homeHref="/mentor" />;
}
