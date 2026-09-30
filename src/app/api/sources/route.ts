import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { findOrCreateSource } from '@/lib/leadSource';
import { SOURCE_NAME_MAX } from '@/lib/leadSourceName';

// The referral-source list as a *picker* feeds, plus in-place creation (#1296).
//
// `/api/admin/sources` stays the admin management endpoint (conversion stats,
// contact details, deletion) and is ADMIN-only. This one is deliberately thin —
// names and ids — and open to MENTOR as well, because the merged referrer field
// lives on screens mentors use: when the person who brought a mentee in has no
// account, they must be able to record them without leaving the form.

// GET — id + name for every source, alphabetical (admin, mentor).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    // The caller's own tenant only (#2570) — the middleware is dormant.
    const sources = await prisma.source.findMany({
      where: withinTenant({}, await tenantWhere(session)),
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    return NextResponse.json({ sources });
  });
}

const schema = z.object({ name: z.string().trim().min(1).max(SOURCE_NAME_MAX) });

// POST — create a source from a picker. An existing name is not an error here:
// the caller wanted "a source called X selected", so the existing row is
// returned and the picker selects it. "Existing" means in the caller's tenant
// (#2570: the name is unique per org) — findOrCreateSource() stamps the org,
// reads the tenant first and falls back on P2002 for a concurrent create.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return await withTenantScope(session, async () => {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { name } = parsed.data;

    let source: { id: string; name: string };
    let created: boolean;
    try {
      const orgId = resolveOrgId(session) ?? (await defaultOrgId());
      const row = await findOrCreateSource(orgId, name);
      source = { id: row.id, name: row.name };
      created = row.created;
    } catch {
      return NextResponse.json({ error: 'Could not create the source' }, { status: 500 });
    }

    if (created) {
      await logActivity({
        action: 'source.created',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'source',
        targetId: source.id,
        detail: source.name,
        request,
      });
    }
    return NextResponse.json({ source, created }, { status: created ? 201 : 200 });
  });
}
