import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { affiliateFunnelBoard } from '@/lib/affiliateFunnelBoard';
import { FUNNEL_PAGE_SIZE, parseFunnelBoardQuery, sortFunnelRows } from '@/lib/affiliateFunnelBoardRule';

// GET — the partner funnel board (docs/affiliate-module.md § The funnel, #3544):
// one row per partner of the session's org for `period`, sorted by an
// allowlisted `sort` key (`dir`, `id` tiebreak), FUNNEL_PAGE_SIZE rows per
// `page`, plus the org total. An unknown period, sort, dir or page is a 400 —
// a request string never reaches a query. `affiliate.read` (OBSERVER included);
// a fixed number of queries whatever the programme's size.
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const parsed = parseFunnelBoardQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return NextResponse.json({ error: 'Invalid query', field: parsed.field }, { status: 400 });
  const { period, sort, dir, page } = parsed.query;

  const board = await affiliateFunnelBoard(orgId, { period });
  const sorted = sortFunnelRows(board.rows, sort, dir);
  const start = (page - 1) * FUNNEL_PAGE_SIZE;
  return NextResponse.json({
    ...board,
    sort,
    dir,
    page,
    pageSize: FUNNEL_PAGE_SIZE,
    totalRows: sorted.length,
    rows: sorted.slice(start, start + FUNNEL_PAGE_SIZE),
  });
}
