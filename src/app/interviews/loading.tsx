import { ListPageSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /interviews/*.
export default function InterviewsLoading() {
  return <ListPageSkeleton rows={5} />;
}
