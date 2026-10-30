import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere } from '@/lib/tenantFilter';
import { acknowledgeBreaches } from '@/lib/slaBreach';

// Bulk acknowledge from the breach queue (#1723) — the same writer as the
// one-row route, so each row is audited on its own. Honest answer: the ids
// acknowledged, and the ones not found (another tenant's look exactly like
// ids that do not exist).
const schema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(50) });

export async function POST(request: Request) {
  const gate = await requirePermission('program.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const ids = Array.from(new Set(parsed.data.ids));
  return await withTenantScope(session, async () => {
    const done = await acknowledgeBreaches(ids, await tenantWhere(session), { id: session.user.id, email: session.user.email }, request);
    const ok = new Set(done);
    return NextResponse.json({ acknowledged: done, missing: ids.filter((id) => !ok.has(id)) });
  });
}
