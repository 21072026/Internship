import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { prisma } from '@/lib/prisma';
import { buildSettingsExport } from '@/lib/affiliateSettingsTransfer';
import { presentSections, transferFileName } from '@/lib/affiliateSettingsTransferRule';

// GET — the programme's settings as one JSON file to import elsewhere (#3622,
// docs/affiliate-module.md § Moving the settings): page content and theme with
// its media, contract, plan, referral address, customer-status thresholds and
// window notice. No partner, customer, payment or person. `affiliate.read` — the
// same data every admin tier already reads on the settings screen — MARKETING
// only; the org comes from the session, never the request. Audited (which
// sections and how many media, never their contents).
export async function GET(request: Request) {
  const auth = await requirePermission('affiliate.read', { request });
  if ('error' in auth) return auth.error;
  const orgId = auth.session.user.orgId;
  if (!orgId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const refusal = await requireCapability(orgId, 'affiliate');
  if (refusal) return refusal;

  const now = new Date();
  const file = await buildSettingsExport(orgId, now);
  await prisma.auditLog.create({
    data: {
      orgId,
      actorId: auth.session.user.id,
      action: 'affiliate.settings.export',
      detail: JSON.stringify({ sections: presentSections(file), assets: file.assets.length }),
    },
  });
  return new NextResponse(JSON.stringify(file), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${transferFileName(now)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
