// "Which roles does this company have open?" has ONE source since #1875:
// `Requisition`. The legacy `CompanyNeed` table is still in the schema (its
// rows are converted on every deploy by backfill 0012, scripts/backfill-
// requisitions.mjs, and the table is only dropped in the separate, approved
// contract step), but nothing reads it for this question any more and no
// screen writes it. Every company payload that shows open positions includes
// exactly this, so the list, the edit dialog and the detail page agree.
//
// Only OPEN counts as open — DRAFT is unpublished, ON_HOLD / FILLED / CANCELLED
// are "do not send me candidates" (the match-alert job's rule, #1387).

export const OPEN_POSITION_STATUS = 'OPEN';

export const openPositionsInclude = {
  where: { status: OPEN_POSITION_STATUS },
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  select: { id: true, title: true, openings: true, filled: true },
};

export type OpenPosition = { id: string; title: string; openings: number; filled: number };
