'use client';

import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';

// A localized badge for an interaction's type (Meeting / Feedback / Email /
// Call / WhatsApp). Self-contained (brings its own useT) so it works even in
// pages that aren't otherwise wired for i18n.
export function InteractionTypeBadge({ type, className }: { type: string; className?: string }) {
  const t = useT();
  const variant = type === 'Meeting' ? 'info' : type === 'Feedback' ? 'success' : 'warning';
  const label = t.interactionTypes[type as keyof typeof t.interactionTypes] ?? type;
  return <Badge variant={variant} className={className}>{label}</Badge>;
}
