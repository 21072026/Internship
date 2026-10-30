// The placement ledger's READ (#1765): one query shared by the ledger screen
// (GET /api/admin/placements) and its CSV export (/api/admin/export/placements),
// so the file can never show a row the screen would not. Server-only.
//
// Scoped twice, like the programme-cost ledger: the tenant middleware
// (Placement is in TENANT_MODELS) and an explicit `orgId` in the WHERE, which is
// what protects a deployment where MT_ENFORCE_ISOLATION is off.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isEmploymentAttribution } from '@/lib/placementKind';
import { isInvoiceState } from '@/lib/placementRule';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 1000;

export interface PlacementFilters {
  from?: string | null;
  to?: string | null;
  companyId?: string | null;
  invoiceState?: string | null;
  attribution?: string | null;
  /** Reversed rows are part of the record but not of the live ledger: off unless asked. */
  includeReversed?: boolean;
}

export function placementFiltersFrom(params: URLSearchParams): PlacementFilters {
  return {
    from: params.get('from'),
    to: params.get('to'),
    companyId: params.get('companyId'),
    invoiceState: params.get('invoiceState'),
    attribution: params.get('attribution'),
    includeReversed: params.get('includeReversed') === '1',
  };
}

export interface PlacementRow {
  id: string;
  relationId: string;
  placedAt: string;
  reversedAt: string | null;
  attribution: string | null;
  feeModel: string | null;
  feeMinor: number | null;
  feeCurrency: string | null;
  invoiceState: string;
  invoiceRef: string | null;
  invoicedAt: string | null;
  mentee: { id: string; fullName: string | null };
  company: { id: string; name: string } | null;
  mentor: { id: string; fullName: string | null } | null;
  source: { id: string; name: string } | null;
  requisition: { id: string; title: string } | null;
}

export async function loadPlacements(orgId: string, filters: PlacementFilters): Promise<PlacementRow[]> {
  const placedAt: Prisma.DateTimeFilter = {};
  // Calendar days, inclusive at both ends, read as UTC (the period arithmetic
  // the rest of the commercial screens use).
  if (filters.from && DAY.test(filters.from)) placedAt.gte = new Date(`${filters.from}T00:00:00.000Z`);
  if (filters.to && DAY.test(filters.to)) placedAt.lt = new Date(new Date(`${filters.to}T00:00:00.000Z`).getTime() + 86_400_000);

  const rows = await prisma.placement.findMany({
    where: {
      orgId,
      ...(Object.keys(placedAt).length ? { placedAt } : {}),
      ...(filters.companyId ? { companyId: filters.companyId } : {}),
      ...(isInvoiceState(filters.invoiceState) ? { invoiceState: filters.invoiceState } : {}),
      // NULL attribution on a pre-#1765 row reads as THROUGH_US.
      ...(isEmploymentAttribution(filters.attribution)
        ? filters.attribution === 'THROUGH_US'
          ? { OR: [{ attribution: 'THROUGH_US' }, { attribution: null }] }
          : { attribution: filters.attribution }
        : {}),
      ...(filters.includeReversed ? {} : { reversedAt: null }),
    },
    orderBy: [{ placedAt: 'desc' }, { id: 'asc' }],
    take: MAX_ROWS,
    select: {
      id: true,
      relationId: true,
      placedAt: true,
      reversedAt: true,
      attribution: true,
      feeModel: true,
      feeMinor: true,
      feeCurrency: true,
      invoiceState: true,
      invoiceRef: true,
      invoicedAt: true,
      creditedMentorId: true,
      sourceId: true,
      requisitionId: true,
      mentee: { select: { id: true, fullName: true } },
      company: { select: { id: true, name: true } },
    },
  });

  // The attribution columns are plain ids (the record outlives what they point
  // at), so their names are looked up here — and a vanished one reads as null.
  const ids = (key: 'creditedMentorId' | 'sourceId' | 'requisitionId') =>
    [...new Set(rows.map((r) => r[key]).filter((v): v is string => !!v))];
  const [mentors, sources, requisitions] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids('creditedMentorId') }, orgId }, select: { id: true, fullName: true } }),
    prisma.source.findMany({ where: { id: { in: ids('sourceId') }, orgId }, select: { id: true, name: true } }),
    prisma.requisition.findMany({ where: { id: { in: ids('requisitionId') }, orgId }, select: { id: true, title: true } }),
  ]);
  const byId = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  const mentorById = byId(mentors);
  const sourceById = byId(sources);
  const requisitionById = byId(requisitions);

  return rows.map((r) => ({
    id: r.id,
    relationId: r.relationId,
    placedAt: r.placedAt.toISOString(),
    reversedAt: r.reversedAt?.toISOString() ?? null,
    attribution: r.attribution,
    feeModel: r.feeModel,
    feeMinor: r.feeMinor,
    feeCurrency: r.feeCurrency,
    invoiceState: r.invoiceState,
    invoiceRef: r.invoiceRef,
    invoicedAt: r.invoicedAt?.toISOString() ?? null,
    mentee: r.mentee,
    company: r.company,
    mentor: (r.creditedMentorId && mentorById.get(r.creditedMentorId)) || null,
    source: (r.sourceId && sourceById.get(r.sourceId)) || null,
    requisition: (r.requisitionId && requisitionById.get(r.requisitionId)) || null,
  }));
}
