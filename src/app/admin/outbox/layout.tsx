import { gatePage } from '@/lib/pageCapabilityGate';
import { gateOutboxPage } from '@/lib/outboxRoute';

// Closed at its URL for a vertical without this module (src/lib/pageCapabilityGate.ts)
// — and, like the sales surface, for a vertical that carries `mentorship`
// (the outbox exists only where approval can be switched on, #2960).
export default async function Layout({ children }: { children: React.ReactNode }) {
  await gatePage('/admin/outbox');
  await gateOutboxPage();
  return <>{children}</>;
}
