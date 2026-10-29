import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { actorFromSession, can, requirePermission } from '@/lib/authz';
import { recordOrgWrite } from '@/lib/orgAudit';
import { orgExportChunks } from '@/lib/orgExport';
import { getServerDictionary } from '@/i18n/server';

// GET /api/admin/organizations/[id]/export (#1584, docs/tenant-lifecycle.md
// § Export) — the whole tenant as one streamed JSON document, credentials
// omitted and listed in `_meta`.
//
// WHO: the super admin of the org's world (`platform.org.read`), or that org's
// own ORG_ADMIN (`org.export` — no tenant permission crosses an org, so an
// admin of another tenant is refused with a denial row, never a 404 that would
// confirm the id). An impersonated session holds neither.
//
// Every export leaves an `org.exported` row (ActivityLog + the tenant's
// AuditLog) naming the actor, before the first byte goes out.

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const actor = await actorFromSession(session);
  if (!session || !actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // `can()` for the platform question writes no denial row — a tenant admin
  // exporting its own org is not a refused platform attempt.
  const platform = await can(actor, 'platform.org.read', { orgId: id }, session);
  if (!platform) {
    const gate = await requirePermission('org.export', { subject: { orgId: id }, request });
    if ('error' in gate) return gate.error;
  }

  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true, slug: true } });
  if (!org) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });

  await recordOrgWrite({
    orgId: id,
    action: 'org.exported',
    actorId: actor.id,
    actorEmail: session.user?.email ?? null,
    detail: `full tenant export by ${platform ? 'super admin' : 'org admin'}`,
    level: 'warning',
    request,
  });

  const { locale, t } = await getServerDictionary();
  const chunks = orgExportChunks({ orgId: id, dict: t, locale });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });

  const day = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="tenant-export-${org.slug}-${day}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
