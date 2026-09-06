import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /account. The layout's back link stays above it.
export default function AccountLoading() {
  return <ListPageSkeleton rows={5} />;
}
