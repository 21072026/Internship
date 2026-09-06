import { DashboardSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /company/* — dashboard, requisitions and analytics all
// open with a stat row over a list.
export default function CompanyLoading() {
  return <DashboardSkeleton />;
}
