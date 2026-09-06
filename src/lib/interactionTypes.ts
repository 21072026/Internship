// Single source of truth for the interaction-log types (mirrors the Prisma
// `InteractionType` enum). The array holds the *keys* only — the display labels
// are localized in `t.interactionTypes` (EN/TR/DE), the same split that
// src/lib/pipeline.ts uses for pipeline stages. Never pair a key with a
// hardcoded English label at a call site: that is how the mentor's "log an
// interaction" menu ended up untranslated and two types short (#1354).
export const INTERACTION_TYPES = ['Meeting', 'Feedback', 'Email', 'Call', 'WhatsApp'] as const;

export type InteractionType = (typeof INTERACTION_TYPES)[number];
