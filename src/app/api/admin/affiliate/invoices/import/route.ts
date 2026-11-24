import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { runInvoiceImport } from '@/lib/affiliateInvoiceImport';

// POST { csv, columns?, dryRun } — the monthly invoice CSV (#3846,
// src/lib/affiliateInvoiceImport.ts). `affiliate.write`, MARKETING only; the org
// comes from the session. `dryRun: true` is the preview: the same run with a
// writer that does not write. Without `columns` the organisation's saved choice
// is used; a choice that does not fit the file answers 400 `columns` with the
// fields, plus the file's header so the screen can offer it.
// The report's rows are capped in the response; the counts are always complete.
const ROWS_IN_RESPONSE = 1_000;

export async function POST(request: Request) {
  const auth = await requirePermission('affiliate.write', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const raw: unknown = await request.json().catch(() => null);
  const body = raw && typeof raw === 'object' ? (raw as { csv?: unknown; columns?: unknown; dryRun?: unknown }) : null;
  if (!body || typeof body.csv !== 'string' || typeof body.dryRun !== 'boolean') {
    return NextResponse.json({ code: 'invalid_input' }, { status: 400 });
  }

  const result = await runInvoiceImport({ orgId, actorId: auth.session.user.id, csv: body.csv, columns: body.columns ?? undefined, dryRun: body.dryRun });
  if (!result.ok) {
    const status = result.code === 'no_plan' ? 409 : 400;
    return NextResponse.json(result, { status });
  }
  const { report } = result;
  return NextResponse.json({
    ok: true,
    header: result.header,
    columns: result.columns,
    dryRun: report.dryRun,
    total: report.total,
    counts: report.counts,
    truncated: report.rows.length > ROWS_IN_RESPONSE,
    rows: report.rows.slice(0, ROWS_IN_RESPONSE).map((r) => ({
      row: r.row,
      key: r.key,
      status: r.status,
      reason: r.reason ?? null,
      customerRef: r.value?.customerRef ?? null,
      receivedAt: r.value?.receivedAt ?? null,
      paidMinor: r.value?.paidMinor ?? null,
      listAmountMinor: r.value?.listAmountMinor ?? null,
      transactionCount: r.value?.transactionCount ?? null,
    })),
  });
}
