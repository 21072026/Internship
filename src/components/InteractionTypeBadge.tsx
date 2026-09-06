'use client';

import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { interactionTypeStyle } from '@/lib/interactionTypes';

// A localized badge for an interaction's type (Meeting / Feedback / Email /
// Call / WhatsApp). Self-contained (brings its own useT) so it works even in
// pages that aren't otherwise wired for i18n. The colour comes from the shared
// INTERACTION_TYPE_STYLE map so the badge and the mentor dashboard's dot can
// never disagree about the same interaction (#1354).
export function InteractionTypeBadge({ type, className }: { type: string; className?: string }) {
  const t = useT();
  const label = t.interactionTypes[type as keyof typeof t.interactionTypes] ?? type;
  return <Badge variant={interactionTypeStyle(type).badge} className={className}>{label}</Badge>;
}
