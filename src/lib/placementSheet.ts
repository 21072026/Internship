// The placement ledger as an export sheet (#1765) — columns and rows with the
// labels already in the caller's locale, handed to `toCsv()` by the export door.
// Client-safe and Prisma-free: it only formats rows `loadPlacements()` returned.

import type { Sheet } from '@/lib/reports/render';
import type { PlacementRow } from '@/lib/placementQuery';
import { effectiveAttribution, formatMinor } from '@/lib/placementRule';

export interface PlacementSheetDict {
  title: string;
  reversed: string;
  columns: Record<
    'placedAt' | 'mentee' | 'company' | 'requisition' | 'mentor' | 'source' | 'attribution' | 'fee' | 'invoiceState' | 'invoiceRef',
    string
  >;
  attributions: Record<string, string>;
  invoiceStates: Record<string, string>;
}

export function placementsSheet(rows: PlacementRow[], d: PlacementSheetDict): Sheet {
  const c = d.columns;
  return {
    name: d.title,
    columns: [c.placedAt, c.mentee, c.company, c.requisition, c.mentor, c.source, c.attribution, c.fee, c.invoiceState, c.invoiceRef],
    rows: rows.map((r) => [
      r.placedAt.slice(0, 10),
      r.mentee.fullName ?? '',
      r.company?.name ?? '',
      r.requisition?.title ?? '',
      r.mentor?.fullName ?? '',
      r.source?.name ?? '',
      d.attributions[effectiveAttribution(r.attribution)] ?? '',
      formatMinor(r.feeMinor, r.feeCurrency),
      `${d.invoiceStates[r.invoiceState] ?? r.invoiceState}${r.reversedAt ? ` (${d.reversed})` : ''}`,
      r.invoiceRef ?? '',
    ]),
  };
}
