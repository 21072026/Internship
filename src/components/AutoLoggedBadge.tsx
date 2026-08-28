'use client';

import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

// Marks an interaction the system wrote itself from a meeting that took place
// (#1489), so nobody reads the placeholder note as something their mentor
// typed. Renders nothing for a hand-written entry, which keeps the call sites
// to one line.
export function AutoLoggedBadge({ autoLogged, className }: { autoLogged?: boolean; className?: string }) {
  const t = useT();
  if (!autoLogged) return null;
  return (
    <Badge variant="default" className={className} title={t.interactionMeta.autoLoggedHint} data-testid="interaction-auto-logged">
      {t.interactionMeta.autoLogged}
    </Badge>
  );
}
