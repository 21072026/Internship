// Lightweight loading placeholders to improve perceived performance.
// `ui-skeleton` is a styling hook, not a utility: under
// `prefers-reduced-motion: reduce` the pulse is frozen by the blanket rule in
// globals.css, and these blocks are the one case where that leaves nothing to
// see, so they get a static drawn placeholder instead (#2045).
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`ui-skeleton animate-pulse rounded bg-gray-100 dark:bg-gray-800 ${className}`} />;
}

// A vertical stack of row-shaped skeletons for list/table loading states.
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
