'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// The mentor directory is shared by mentees, mentors and admins.
export default function MentorsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="mentors" />;
}
