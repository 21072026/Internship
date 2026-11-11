import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { retryChatDeliveryFor } from '@/lib/chat/workspaces';

// POST — retry one FAILED chat delivery (#1960). Goes through the notification
// router (never straight to the platform) and appends a NEW ledger row; the
// failed one stays as it was. `org.integrations.write`, like the switch.
const STATUS: Record<string, number> = { not_found: 404, not_failed: 409, identity_gone: 409, source_gone: 409, already_retried: 409 };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = resolveOrgId(gate.session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  const { id } = await params;
  const out = await retryChatDeliveryFor(orgId, id, gate.actor.id);
  if (!out.ok) return NextResponse.json({ error: out.code, code: out.code }, { status: STATUS[out.code] ?? 400 });
  return NextResponse.json(out);
}
