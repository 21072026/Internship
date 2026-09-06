'use client';

import { SharedRouteErrorBoundary } from '@/components/RouteErrorBoundary';

// The project showcase is public, so this tree has no layout of its own — the
// boundary supplies the page container. An anonymous visitor is sent to the
// landing page; a signed-in one to their own dashboard.
//
// Deliberately no `loading.tsx` next to this file (#1602). Everything else in
// the app puts its Suspense fallback inside a layout; here there is no layout,
// so a `loading.tsx` wraps the whole page — header, card and all the client
// components under it — in a streamed boundary hanging straight off the root
// layout. Doing that rendered `/projects/[id]` **twice**: the streamed copy
// stayed in the DOM next to the client re-render, so the roster, the goals and
// the join controls all appeared in duplicate (caught by
// e2e/project-team-and-goals.spec.ts, which then matched two
// `[data-testid="project-team"]` lists). Both routes here are
// `dynamic = 'force-dynamic'` and cheap, so the fallback bought little; if one
// is ever wanted back, it has to sit inside a real layout for this tree.
export default function ProjectsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <SharedRouteErrorBoundary error={error} reset={reset} scope="projects" />
    </div>
  );
}
