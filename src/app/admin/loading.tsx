import { Card } from '@/components/ui/Card';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';

// Route-level Suspense fallback for /admin/* — shown during navigation while
// the next page's server work resolves.
export default function AdminLoading() {
  return (
    <div>
      <div className="mb-6">
        <Skeleton className="h-7 w-48 mb-2" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Card>
        <SkeletonRows rows={6} />
      </Card>
    </div>
  );
}
