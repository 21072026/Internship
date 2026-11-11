import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withRequestScope } from '@/lib/requestContext';
import { klaviyoAdminGate } from '@/lib/klaviyoGate';
import { previewKlaviyo } from '@/lib/klaviyoSync';

// The dry run: the first profiles of the connected account, mapped and planned
// by the SAME engine call a sync makes, with the writer that writes nothing
// (src/lib/importPreview.ts). Nothing is written and the cursor does not move.

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('org.integrations.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const result = await previewKlaviyo(g.orgId);
    if (!result.ok) return NextResponse.json({ ok: false, code: result.code }, { status: result.code === 'not_connected' ? 404 : 200 });
    return NextResponse.json(result);
  });
}
