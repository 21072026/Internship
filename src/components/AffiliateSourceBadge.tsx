'use client';

import { Handshake } from 'lucide-react';
import { useT } from '@/i18n/client';
import { Badge } from '@/components/ui/Badge';

// "Affiliate: <partner>" on a lead that came in through a partner's link
// (#3647). The name is resolved on the server from the lead's Source
// (`affiliate:<code>`, src/lib/affiliateSourceRule.ts) and the org's own
// AffiliatePartner — this only renders it, and renders nothing without one.
export function AffiliateSourceBadge({ partnerName, className }: { partnerName: string | null | undefined; className?: string }) {
  const t = useT();
  if (!partnerName) return null;
  return (
    <Badge variant="info" className={`inline-flex max-w-full items-center gap-1 ${className ?? ''}`} data-testid="affiliate-source-badge">
      <Handshake className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      <span className="truncate">{t.affiliateSource.badge.replace('{partner}', partnerName)}</span>
    </Badge>
  );
}
