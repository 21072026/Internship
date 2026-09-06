'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Error boundary for /messages/*. MessagesShell (the full-height frame with its
// own back/home header) stays mounted above this.
export default function MessagesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="messages" />;
}
