import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for the mentor directory.
export default function MentorsLoading() {
  return <ListPageSkeleton rows={6} />;
}
