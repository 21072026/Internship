'use client';

import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import type { InteractionType } from '@/lib/interactionTypes';

// One colour per type, exhaustive over InteractionType (#1354): Call and
// WhatsApp used to fall into the same catch-all as Email, so three of the five
// types were indistinguishable at a glance.
const VARIANT: Record<InteractionType, 'info' | 'success' | 'warning' | 'purple' | 'default'> = {
  Meeting: 'info',
  Feedback: 'success',
  Email: 'warning',
  Call: 'purple',
  WhatsApp: 'default',
};

// A localized badge for an interaction's type (Meeting / Feedback / Email /
// Call / WhatsApp). Self-contained (brings its own useT) so it works even in
// pages that aren't otherwise wired for i18n.
export function InteractionTypeBadge({ type, className }: { type: string; className?: string }) {
  const t = useT();
  const variant = VARIANT[type as InteractionType] ?? 'default';
  const label = t.interactionTypes[type as keyof typeof t.interactionTypes] ?? type;
  return <Badge variant={variant} className={className}>{label}</Badge>;
}
