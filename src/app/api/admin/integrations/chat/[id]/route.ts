import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { setChatWorkspaceEnabled, uninstallChatWorkspace } from '@/lib/chat/workspaces';

// PATCH { enabled } — the per-workspace kill switch (#1958). Disabling stops
// chat delivery at the next send: the adapter records SKIPPED and every other
// channel still goes, so nobody loses a notification.
//
// DELETE — the real uninstall: platform-side revoke, then the workspace, its
// sealed tokens and its identities are deleted (src/lib/chat/workspaces.ts).
//
// Both behind `org.integrations.write` (ORG_ADMIN; an OBSERVER or PROGRAM_ADMIN
// is refused with a denial row). A workspace of another org is 404 — the
// filter is the caller's orgId, so the id is never confirmed.

const patchSchema = z.object({ enabled: z.boolean() }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = resolveOrgId(gate.session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { id } = await params;
  const ok = await setChatWorkspaceEnabled(orgId, id, parsed.data.enabled, gate.actor.id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true, enabled: parsed.data.enabled });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = resolveOrgId(gate.session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  const { id } = await params;
  const out = await uninstallChatWorkspace(orgId, id, gate.actor.id);
  if (!out) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true, ...out });
}
