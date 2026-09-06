'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Notification history is available to every authenticated role.
export default function NotificationsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="notifications" />;
}
