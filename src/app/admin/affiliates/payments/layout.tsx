import { gatePage } from '@/lib/pageCapabilityGate';

// Closed at its URL for a vertical without the affiliate module (docs/affiliate-module.md).
export default async function AffiliatePaymentsLayout({ children }: { children: React.ReactNode }) {
  await gatePage('/admin/affiliates/payments');
  return <>{children}</>;
}
