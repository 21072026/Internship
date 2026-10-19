'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { useT } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { NewMarketingLeadDialog } from '@/components/admin/NewMarketingLeadDialog';

// The sales rep's "New lead" (#2958): the admin form's dialog on the rep's own
// door, POST /api/sales/leads — the lead is always placed on the rep's own book.
// The pages behind it are server components, so a created lead refreshes them.
export function NewSalesLeadButton() {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} data-testid="new-lead-button">
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        {t.sales.newLead.button}
      </Button>
      {open && (
        <NewMarketingLeadDialog surface="sales" onClose={() => setOpen(false)} onCreated={() => router.refresh()} />
      )}
    </>
  );
}
