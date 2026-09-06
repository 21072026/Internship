'use client';

import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

// App Router error boundary for everything under /admin. AdminLayout (sidebar,
// header) stays mounted above this — only the page content is replaced.
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteErrorBoundary error={error} reset={reset} scope="admin" homeHref="/admin" />;
}
