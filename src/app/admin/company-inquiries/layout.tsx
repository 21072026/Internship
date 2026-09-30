import { gatePage } from '@/lib/pageCapabilityGate';

// Closed at its URL for a vertical without this module (src/lib/pageCapabilityGate.ts).
export default async function Layout({ children }: { children: React.ReactNode }) {
  await gatePage('/admin/company-inquiries');
  return <>{children}</>;
}
