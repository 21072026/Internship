import { DashboardSkeleton } from '@/components/PageSkeleton';

// Suspense fallback for /portal/*. PortalTabs stays mounted above this, so the
// fallback only stands in for the panel below the tabs.
export default function PortalLoading() {
  return <DashboardSkeleton tiles={3} />;
}
