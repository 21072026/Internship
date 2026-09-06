'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// An interview panel is convened by an admin and scored by mentors, so the
// boundary sends each of them back to their own dashboard.
export default function InterviewsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SharedRouteErrorBoundary error={error} reset={reset} scope="interviews" />;
}
