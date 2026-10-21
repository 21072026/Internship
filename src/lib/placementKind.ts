// What a mentorship relation is FOR, and whose outcome a hire is (#1503).
// Client-safe (no Prisma import) so routes and UI share one list — validated
// like the drop-off reasons: z.string() + this whitelist, never z.enum
// (CLAUDE.md, src/lib/dropoffReasons.ts).

/** PLACEMENT is in the hiring funnel and counts; COACHING is mentoring with no placement goal. */
export const RELATION_KINDS = ['PLACEMENT', 'COACHING'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];
export const DEFAULT_RELATION_KIND: RelationKind = 'PLACEMENT';

export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === 'string' && (RELATION_KINDS as readonly string[]).includes(value);
}

/**
 * Whose outcome a hire is. THROUGH_US counts as a placement; SELF_FOUND and
 * ALREADY_EMPLOYED are honest outcomes that are not ours. A NULL stored value
 * is "not stated" and is read as THROUGH_US for rows from before the column.
 */
export const EMPLOYMENT_ATTRIBUTIONS = ['THROUGH_US', 'SELF_FOUND', 'ALREADY_EMPLOYED'] as const;
export type EmploymentAttribution = (typeof EMPLOYMENT_ATTRIBUTIONS)[number];

export function isEmploymentAttribution(value: unknown): value is EmploymentAttribution {
  return typeof value === 'string' && (EMPLOYMENT_ATTRIBUTIONS as readonly string[]).includes(value);
}

/**
 * The `funnelEnteredAt` a kind change writes: entering PLACEMENT stamps `now`,
 * leaving it clears the column; anything else leaves it alone (`undefined`).
 */
export function funnelEnteredAtForKindChange(
  from: string,
  to: RelationKind,
  now: Date,
): Date | null | undefined {
  if (from === to) return undefined;
  return to === 'PLACEMENT' ? now : null;
}

