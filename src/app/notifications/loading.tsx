import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /notifications — a feed of rows.
export default function NotificationsLoading() {
  return <ListPageSkeleton rows={8} />;
}
