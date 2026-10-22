import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { klaviyoAdminGate } from '@/lib/klaviyoGate';
import { previewKlaviyo } from '@/lib/klaviyoSync';

// The dry run: the first profiles of the connected account, mapped and planned
// by the SAME engine call a sync makes, with the writer that writes nothing
// (src/lib/importPreview.ts). Nothing is written and the cursor does not move.

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const result = await previewKlaviyo(g.orgId);
    if (!result.ok) return NextResponse.json({ ok: false, code: result.code }, { status: result.code === 'not_connected' ? 404 : 200 });
    return NextResponse.json(result);
  });
}
