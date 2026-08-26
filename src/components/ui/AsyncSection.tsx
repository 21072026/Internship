import { type ReactNode } from 'react';
import { Button } from './Button';
import { Skeleton, SkeletonRows } from './Skeleton';

export type AsyncSectionSkeleton = 'list' | 'card' | 'stats';

interface AsyncSectionProps {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyText: ReactNode;
  retryText?: ReactNode;
  onRetry?: () => void;
  skeleton?: AsyncSectionSkeleton;
  children: ReactNode;
}

function LoadingSkeleton({ variant }: { variant: AsyncSectionSkeleton }) {
  if (variant === 'card') {
    return (
      <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true" data-skeleton="card">
        <Skeleton className="h-28 dark:bg-gray-800" />
        <Skeleton className="h-28 dark:bg-gray-800" />
      </div>
    );
  }
  if (variant === 'stats') {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-hidden="true" data-skeleton="stats">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 dark:bg-gray-800" />
        ))}
      </div>
    );
  }
  return <div data-skeleton="list"><SkeletonRows rows={4} /></div>;
}

// Presentation only: callers retain ownership of fetching, retries and state.
// The order is the contract — loading must always win over error and empty.
export function AsyncSection({
  loading,
  error,
  empty,
  emptyText,
  retryText,
  onRetry,
  skeleton = 'list',
  children,
}: AsyncSectionProps) {
  if (loading) {
    return (
      <div data-testid="async-section-loading">
        <LoadingSkeleton variant={skeleton} />
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        data-testid="async-section-error"
        className="flex flex-col items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30"
      >
        <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        {onRetry && retryText ? (
          <Button variant="outline" size="sm" onClick={onRetry}>{retryText}</Button>
        ) : null}
      </div>
    );
  }

  if (empty) {
    return <div data-testid="async-section-empty">{emptyText}</div>;
  }

  return <>{children}</>;
}
