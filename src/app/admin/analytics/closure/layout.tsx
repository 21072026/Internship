import { gateCapability } from '@/lib/pageCapabilityGate';

// This report is the internship product's — how pairings ended — so a vertical without
// `mentorship` gets a 404 here, and its API refuses it too (#2348). No nav
// link names this path, hence gateCapability() rather than gatePage(); the
// dictionary scope comes from admin/analytics/layout.tsx above.
export default async function Layout({ children }: { children: React.ReactNode }) {
  await gateCapability('mentorship');
  return <>{children}</>;
}
