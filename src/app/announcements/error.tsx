'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// Announcement history is available to every authenticated role.
export default function AnnouncementsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="announcements" />;
}
