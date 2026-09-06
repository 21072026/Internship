'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// The to-do list belongs to the person, not a role — "back" follows the
// session, the same way the layout's back link does.
export default function TodosError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="todos" />;
}
