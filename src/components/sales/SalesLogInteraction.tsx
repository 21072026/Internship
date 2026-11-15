'use client';

import { useRouter } from 'next/navigation';
import { AddInteractionForm } from '@/components/AddInteractionForm';
import { ContactActions } from '@/components/ContactActions';

// Logging a call/meeting from the rep's lead page (#2580 review). The same form
// and route an admin uses (POST /api/interactions, owner-checked there); the
// lead page is a server component, so a refresh re-reads the list. It is also
// what makes a rep's own work visible to the #1750 meter ("any logged activity
// in the calendar month").
//
// With a `phone`, the same click-to-call/WhatsApp buttons as the mentor's mentee
// page (#3748): "reached them? yes" logs the interaction through the same route,
// so the first-contact stage rule and the meter see it like a typed one. The page
// passes a phone only when the viewer may write interactions on this record.
export function SalesLogInteraction({ relationId, phone }: { relationId: string; phone?: string | null }) {
  const router = useRouter();
  return (
    <div data-testid="sales-lead-log-interaction">
      {phone && (
        <div className="mb-3" data-testid="sales-lead-contact-actions">
          <ContactActions relationId={relationId} phone={phone} onLogged={() => router.refresh()} />
        </div>
      )}
      <AddInteractionForm relationId={relationId} onAdded={() => router.refresh()} />
    </div>
  );
}
