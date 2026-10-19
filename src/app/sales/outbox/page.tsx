import { OutboxPanel } from '@/components/outbox/OutboxPanel';
import { gateOutboxPage } from '@/lib/outboxRoute';

// A sales rep's share of the outbox (#2960): the drafts addressed to their own
// leads and accounts (visibleDraftsWhere, src/lib/outboundDrafts.ts). Here and
// not under /admin because the admin shell is ADMIN-only; the API is the same.
export default async function SalesOutboxPage() {
  await gateOutboxPage();
  return <OutboxPanel />;
}
