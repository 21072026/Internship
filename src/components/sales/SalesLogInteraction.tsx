'use client';

import { useRouter } from 'next/navigation';
import { AddInteractionForm } from '@/components/AddInteractionForm';

// Logging a call/meeting from the rep's lead page (#2580 review). The same form
// and route an admin uses (POST /api/interactions, owner-checked there); the
// lead page is a server component, so a refresh re-reads the list. It is also
// what makes a rep's own work visible to the #1750 meter ("any logged activity
// in the calendar month").
export function SalesLogInteraction({ relationId }: { relationId: string }) {
  const router = useRouter();
  return (
    <div data-testid="sales-lead-log-interaction">
      <AddInteractionForm relationId={relationId} onAdded={() => router.refresh()} />
    </div>
  );
}
