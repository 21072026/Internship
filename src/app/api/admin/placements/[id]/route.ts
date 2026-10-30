import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { canChangeInvoiceState, isInvoiceState } from '@/lib/placementRule';

// PATCH /api/admin/placements/[id] (#1765) — move a placement's invoice state.
//
// The billing act of the ledger, so it takes the permission the rest of the
// commercial configuration takes (`org.settings.write`: ORG_ADMIN only) and
// every accepted change writes an AuditLog row with the org passed explicitly
// (docs/audit-stream.md). Which moves exist is `canChangeInvoiceState()`; the
// write is a guarded `updateMany` on the state we read, so two admins clicking
// at once cannot both win (the loser gets 409).
//
// It never touches the stamp itself — placedAt, attribution, reversal are the
// subscriber's (src/lib/placementLedger.ts).

const patchSchema = z
  .object({
    invoiceState: z.string().refine(isInvoiceState, 'unknown invoiceState'),
    invoiceRef: z.string().trim().max(64).nullable().optional(),
  })
  .strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
    const blocked = await requireCapability(orgId, 'placements');
    if (blocked) return blocked;

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const to = parsed.data.invoiceState as Parameters<typeof canChangeInvoiceState>[0]['to'];
    const invoiceRef = parsed.data.invoiceRef?.trim() || null;

    // Another tenant's id matches nothing: 404, the same answer as a missing one.
    const placement = await prisma.placement.findFirst({
      where: { id, orgId },
      select: { id: true, invoiceState: true, invoiceRef: true, reversedAt: true },
    });
    if (!placement) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const verdict = canChangeInvoiceState({ from: placement.invoiceState, to, reversed: !!placement.reversedAt, invoiceRef });
    if (!verdict.ok) return NextResponse.json({ error: 'Invoice state change refused', code: verdict.code }, { status: 400 });

    const now = new Date();
    const result = await prisma.placement.updateMany({
      where: { id, orgId, invoiceState: placement.invoiceState },
      data: {
        invoiceState: to,
        // INVOICED carries its reference and date; leaving it clears both, so
        // the row never claims an invoice it no longer has.
        invoiceRef: to === 'INVOICED' ? invoiceRef : null,
        invoicedAt: to === 'INVOICED' ? now : null,
      },
    });
    if (result.count === 0) return NextResponse.json({ error: 'Placement changed meanwhile', code: 'state_conflict' }, { status: 409 });

    await prisma.auditLog.create({
      data: {
        orgId,
        actorId: session.user.id,
        action: 'PLACEMENT_INVOICE_STATE',
        targetId: id,
        detail: JSON.stringify({ from: placement.invoiceState, to, invoiceRef: to === 'INVOICED' ? invoiceRef : null }),
      },
    });
    await logActivity({
      action: 'placement.invoice_state',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'placement',
      targetId: id,
      detail: `${placement.invoiceState} → ${to}`,
      request,
    });

    return NextResponse.json({ ok: true, invoiceState: to });
  });
}
