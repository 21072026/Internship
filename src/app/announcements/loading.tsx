import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /announcements.
export default function AnnouncementsLoading() {
  return <ListPageSkeleton rows={6} />;
}
