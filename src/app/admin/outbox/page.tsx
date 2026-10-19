import { OutboxPanel } from '@/components/outbox/OutboxPanel';

// The outbox (#2960): every draft of the admin's organization. The API decides
// the scope; the layout closes the URL for a vertical without the outbox.
export default function AdminOutboxPage() {
  return <OutboxPanel />;
}
