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

/** The default pipeline's hire stages; a tenant's own last on-path stage counts too. */
export const ATTRIBUTION_STAGE_KEYS = ['HIRED_660', 'EMPLOYED_700'] as const;

/**
 * Is a move into `toStatus` the moment a hire happens — where the attribution
 * belongs? The default hire keys, or the org's LAST on-path stage (its own
 * pipeline, #747 — never a hardcoded list beyond the defaults).
 */
export function isAttributionStage(
  stages: readonly { key: string; order: number; isOffPath: boolean }[],
  toStatus: string,
): boolean {
  if ((ATTRIBUTION_STAGE_KEYS as readonly string[]).includes(toStatus)) return true;
  const onPath = stages.filter((s) => !s.isOffPath);
  if (onPath.length === 0) return false;
  const last = onPath.reduce((a, b) => (b.order > a.order ? b : a));
  return last.key === toStatus;
}
