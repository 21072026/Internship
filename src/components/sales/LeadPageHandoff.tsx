'use client';

import { useRouter } from 'next/navigation';
import { UserRoundPlus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/client';
import { useLeadHandoff } from '@/components/board/LeadHandoff';

// "Hand over" on the lead page (#3657): the board's hand-off (#3672) — the same
// dialog, the same POST /api/sales/leads/[id]/handoff and the same rule
// (src/lib/leadHandoffRule.ts) — without going back to the board. Once handed
// over the record is no longer on the rep's book and this page would 404, so
// the rep is taken back to /sales. Renders nothing where the team endpoint
// answers no colleague (outside MARKETING, or a team of one).
export function LeadPageHandoff({ relationId, leadName }: { relationId: string; leadName: string }) {
  const t = useT();
  const router = useRouter();
  const handoff = useLeadHandoff({
    includeSelf: false,
    nameOf: () => leadName,
    onHandedOff: () => {
      router.push('/sales');
      router.refresh();
    },
  });
  if (!handoff.enabled) return null;
  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => handoff.openFor(relationId)} data-testid="sales-lead-handoff">
        <UserRoundPlus className="mr-1 h-4 w-4" aria-hidden="true" />
        {t.leadHandoff.cardButton}
      </Button>
      {handoff.dialog}
    </>
  );
}
