'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// The project showcase is public, so this tree has no layout of its own — the
// boundary supplies the page container. An anonymous visitor is sent to the
// landing page; a signed-in one to their own dashboard.
export default function ProjectsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <SharedRouteErrorBoundary error={error} reset={reset} scope="projects" />
    </div>
  );
}
