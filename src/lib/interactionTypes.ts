// Single source of truth for the interaction-log types (mirrors the Prisma
// `InteractionType` enum). The array holds the *keys* only — the display labels
// are localized in `t.interactionTypes` (EN/TR/DE), the same split that
// src/lib/pipeline.ts uses for pipeline stages. Never pair a key with a
// hardcoded English label at a call site: that is how the mentor's "log an
// interaction" menu ended up untranslated and two types short (#1354).
export const INTERACTION_TYPES = ['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp'] as const;

export type InteractionType = (typeof INTERACTION_TYPES)[number];

// One colour per type, exhaustive over InteractionType (#1354) and shared by
// every surface that colour-codes an interaction — the badge
// (`InteractionTypeBadge`) and the mentor dashboard's recent-interactions dot.
// Keeping the two in one map is the point: while the dot kept its own
// three-branch ternary, a `Call` row showed a purple badge next to the
// catch-all dot, i.e. the same interaction described in two colours.
// `dot` values are Tailwind classes, which is why `./src/lib/**` is in the
// Tailwind `content` globs (tailwind.config.ts) — do not inline them again.
export const INTERACTION_TYPE_STYLE: Record<
  InteractionType,
  { badge: 'default' | 'success' | 'warning' | 'info' | 'purple'; dot: string }
> = {
  Meeting: { badge: 'info', dot: 'bg-blue-500' },
  Feedback: { badge: 'success', dot: 'bg-green-500' },
  Email: { badge: 'warning', dot: 'bg-yellow-500' },
  Call: { badge: 'purple', dot: 'bg-purple-500' },
  WhatsApp: { badge: 'default', dot: 'bg-gray-400' },
};

// Style for an arbitrary (possibly unknown/legacy) type string.
export function interactionTypeStyle(type: string) {
  return (
    INTERACTION_TYPE_STYLE[type as InteractionType] ?? {
      badge: 'default' as const,
      dot: 'bg-gray-400',
    }
  );
}
