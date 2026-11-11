import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { loadRun, toRunCsv } from '@/lib/rosterFeedAdmin';

// One run and its per-row outcomes (#1967): filterable by action, paginated,
// and `?format=csv` for the whole report as a spreadsheet. The deprovisioning
// rows (#1966) carry negative row numbers: no file row describes them.
// Another org's feed or run answers 404.

const PAGE_SIZE = 50;
const STATUSES = ['CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'ERROR', 'DEACTIVATE', 'REACTIVATE'] as const;
type Status = (typeof STATUSES)[number];
/** At most this many rows in one export — a roster is bounded by the 8 MiB file cap anyway. */
const CSV_MAX_ROWS = 100_000;

type Ctx = { params: Promise<{ id: string; runId: string }> };

// In the order they were written: the import's rows (file order within each
// chunk) before the deprovisioning phase that follows them, and a later
// night's phase on an unchanged file after that.
const ROW_ORDER = [{ createdAt: 'asc' as const }, { rowNumber: 'asc' as const }];

const ROW_SELECT = { rowNumber: true, key: true, status: true, message: true, changed: true, userId: true } as const;

export async function GET(request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.integrations.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id, runId } = await params;
  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const status = STATUSES.includes(statusParam as Status) ? (statusParam as Status) : undefined;
  const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));
  const csv = url.searchParams.get('format') === 'csv';

  return withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    const run = await loadRun(id, runId, orgId);
    if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const where = { runId, orgId, ...(status ? { status } : {}) };

    if (csv) {
      const rows = await prisma.rosterRowResult.findMany({
        where,
        orderBy: ROW_ORDER,
        take: CSV_MAX_ROWS,
        select: ROW_SELECT,
      });
      return new NextResponse(toRunCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="roster-run-${run.id}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const [rows, total, byStatus] = await Promise.all([
      prisma.rosterRowResult.findMany({
        where,
        orderBy: ROW_ORDER,
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: ROW_SELECT,
      }),
      prisma.rosterRowResult.count({ where }),
      prisma.rosterRowResult.groupBy({ by: ['status'], where: { runId, orgId }, _count: { _all: true } }),
    ]);
    return NextResponse.json({
      run,
      rows,
      total,
      page,
      pageSize: PAGE_SIZE,
      statuses: STATUSES,
      counts: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
    });
  });
}
