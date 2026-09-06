import { Card } from '@/components/ui/Card';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';

/**
 * The shapes used by the route-level `loading.tsx` files (#1602).
 *
 * These are Suspense fallbacks, not spinners: the point is that the fallback
 * occupies roughly the same space as the page that replaces it, so the layout
 * does not jump when the server work resolves. Server components — a loading
 * fallback must never depend on hydration to appear.
 *
 * `SkeletonRows` is already `aria-hidden`; the wrappers add no text of their
 * own, so there is nothing here to translate.
 */

/** Page title + subtitle, the header every screen in this app opens with. */
export function SkeletonPageHeader({ subtitle = true }: { subtitle?: boolean }) {
  return (
    <div className="mb-6" aria-hidden="true">
      <Skeleton className="h-7 w-48 mb-2" />
      {subtitle && <Skeleton className="h-4 w-72" />}
    </div>
  );
}

/** Header + a single card of rows — the plain list/detail screen. */
export function ListPageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div>
      <SkeletonPageHeader />
      <Card>
        <SkeletonRows rows={rows} />
      </Card>
    </div>
  );
}

/** Header + a row of stat tiles + a card of rows — the role dashboards. */
export function DashboardSkeleton({ tiles = 4, rows = 5 }: { tiles?: number; rows?: number }) {
  return (
    <div>
      <SkeletonPageHeader />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6" aria-hidden="true">
        {Array.from({ length: tiles }).map((_, i) => (
          <Card key={i}>
            <Skeleton className="h-4 w-24 mb-3" />
            <Skeleton className="h-7 w-16" />
          </Card>
        ))}
      </div>
      <Card>
        <SkeletonRows rows={rows} />
      </Card>
    </div>
  );
}

/**
 * Conversation shape: a stack of alternating bubbles rather than table rows,
 * so /messages does not flash a list layout before showing a chat.
 */
export function ConversationSkeleton({ bubbles = 6 }: { bubbles?: number }) {
  return (
    <div className="space-y-4 py-4" aria-hidden="true">
      {Array.from({ length: bubbles }).map((_, i) => (
        <div key={i} className={i % 2 === 0 ? 'flex justify-start' : 'flex justify-end'}>
          <Skeleton className={`h-14 rounded-2xl ${i % 3 === 0 ? 'w-3/5' : 'w-2/5'}`} />
        </div>
      ))}
    </div>
  );
}
