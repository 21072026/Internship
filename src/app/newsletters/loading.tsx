import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /newsletters.
export default function NewslettersLoading() {
  return <ListPageSkeleton rows={5} />;
}
