import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { z } from 'zod';
import { withRequestScope } from '@/lib/requestContext';
import { logActivity } from '@/lib/activity';
import { klaviyoAdminGate } from '@/lib/klaviyoGate';
import { klaviyoResetApply, klaviyoResetPreview } from '@/lib/klaviyoReset';
import { klaviyoConnectionView } from '@/lib/klaviyoSync';

// "Delete what Klaviyo brought in and read it again" (src/lib/klaviyoReset.ts).
// GET is the preview: how many accounts go, how many stay and why. POST applies
// it, but only for the number the admin confirmed (`expectRemove`): a plan that
// changed in between deletes nothing and answers 409 with the new preview.
// The org is the session's (klaviyoAdminGate), never a parameter.

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('org.integrations.read', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    return NextResponse.json(await klaviyoResetPreview(g.orgId));
  });
}

const bodySchema = z.object({ expectRemove: z.number().int().min(0).max(1_000_000) });

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('org.integrations.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const g = await klaviyoAdminGate(session);
    if (!g.ok) return g.response;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const outcome = await klaviyoResetApply(g.orgId, parsed.data.expectRemove);
    if (!outcome.ok) {
      return outcome.code === 'not_connected'
        ? NextResponse.json({ error: 'Not connected', code: 'not_connected' }, { status: 404 })
        : NextResponse.json({ error: 'The plan changed', code: 'plan_changed', preview: outcome.preview }, { status: 409 });
    }
    await logActivity({
      action: 'integration.klaviyo.reset',
      level: 'warning',
      orgId: g.orgId,
      actorId: g.userId,
      targetType: 'ExternalConnection',
      detail: `removed=${outcome.result.removed} kept=${outcome.result.kept} changed=${outcome.result.changed}`,
      request,
    });
    return NextResponse.json({ ...outcome.result, ...(await klaviyoConnectionView(g.orgId)) });
  });
}
