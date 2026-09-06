import { DashboardSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /source/*.
export default function SourceLoading() {
  return <DashboardSkeleton tiles={3} />;
}
