import { gatePage } from '@/lib/pageCapabilityGate';

// Same module as the job board (#1832): closed at its URL for a vertical without placements.
export default async function Layout({ children }: { children: React.ReactNode }) {
  await gatePage('/portal/jobs');
  return <>{children}</>;
}
