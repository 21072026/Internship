import { ListPageSkeleton } from '@/components/PageSkeleton';

// Route-level Suspense fallback for /admin/* — shown during navigation while
// the next page's server work resolves.
//
// Side effect worth knowing: because this boundary streams the shell first, a
// page under it that calls notFound() answers 200 (with the not-found UI), never
// 404. A page that must be a real 404 lives in src/app/(unstreamed)/admin
// instead — see the layout there (#2560).
export default function AdminLoading() {
  return <ListPageSkeleton />;
}
