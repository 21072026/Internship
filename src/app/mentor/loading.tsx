import { DashboardSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /mentor/* — the mentor home is a stat row over a
// mentee list, so the fallback is that shape and the page does not jump.
export default function MentorLoading() {
  return <DashboardSkeleton />;
}
