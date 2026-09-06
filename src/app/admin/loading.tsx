import { ListPageSkeleton } from '@/components/PageSkeleton';

// Route-level Suspense fallback for /admin/* — shown during navigation while
// the next page's server work resolves.
export default function AdminLoading() {
  return <ListPageSkeleton />;
}
