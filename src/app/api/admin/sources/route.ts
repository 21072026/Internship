import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { outcomeStageKeys } from '@/lib/pipelineStages';
import { attributedLeadWhere } from '@/lib/leadAttribution';
import { getLocale } from '@/i18n/server';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { findSourceByName } from '@/lib/leadSource';
import { SOURCE_NAME_MAX } from '@/lib/leadSourceName';

// GET — all sources with lead counts + conversion breakdown (admin).
//
// Both halves of the count come from a rule stated elsewhere, never from a
// literal here (#2421): the finished stages are the TENANT's own set resolved by
// `outcomeStageKeys()` (a hardcoded HIRED_660/EMPLOYED_700 reported 0% for every
// source of an org on its own catalogue, #1882), and who may be counted toward a
// source is src/lib/leadAttribution.ts.
//
// The ratio's DENOMINATOR is filtered by the same `attributedLeadWhere()` as its
// numerator. It was not: a bare `_count` of the relation counts every User with
// that `sourceId`, and on a SOURCE login that column records which source the
// account speaks for rather than who referred it — so on this very screen, where
// a partner institution having its own login is the normal case, a source with
// one partner login and one hired lead reported 50% instead of 100%.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const locale = await getLocale();

  return await withTenantScope(session, async () => {
  const orgId = (session.user as { orgId?: string | null }).orgId ?? null;
  const outcome = await outcomeStageKeys(orgId, locale);
  // The caller's tenant, by hand (#2570): the middleware is dormant, and a
  // source list is tenant data like any other.
  const tenant = await tenantWhere(session);

  const sources = await prisma.source.findMany({
    where: withinTenant({}, tenant),
    orderBy: { name: 'asc' },
    include: { _count: { select: { users: { where: attributedLeadWhere() } } } },
  });

  // For each source, how many of its leads reached a finished stage.
  const hiredRows = await prisma.user.groupBy({
    by: ['sourceId'],
    where: withinTenant(
      {
        ...attributedLeadWhere(),
        sourceId: { not: null },
        menteeRelations: { some: { pipelineStatus: { in: outcome.finished } } },
      },
      tenant,
    ),
    _count: { _all: true },
  });
  const hiredBySource: Record<string, number> = {};
  for (const r of hiredRows) if (r.sourceId) hiredBySource[r.sourceId] = r._count?._all ?? 0;

  return NextResponse.json({
    sources: sources.map((s) => {
      const mentees = s._count.users;
      const hired = hiredBySource[s.id] ?? 0;
      return {
        id: s.id,
        name: s.name,
        contactName: s.contactName,
        contactEmail: s.contactEmail,
        mentees,
        hired,
        conversion: mentees > 0 ? Math.round((hired / mentees) * 100) : 0,
      };
    }),
  });
  });
}

const schema = z.object({
  name: z.string().trim().min(1).max(SOURCE_NAME_MAX),
  contactName: z.string().max(120).optional(),
  contactEmail: z.string().email().max(160).optional().or(z.literal('')),
});

// POST — create a source (admin).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { name, contactName, contactEmail } = parsed.data;
  // Unique PER TENANT (#2570): `(orgId, name)`. The row is stamped with the
  // caller's org — a session without one is the default org's, the same rule
  // tenantWhere() reads by — and the duplicate check reads that tenant,
  // legacy NULL-org rows included (src/lib/leadSource.ts says why a pre-read
  // and not only the index). Another tenant's "Google" is no conflict.
  const orgId = resolveOrgId(session) ?? (await defaultOrgId());
  const conflict = () => NextResponse.json({ error: 'A source with that name already exists' }, { status: 409 });
  if (await findSourceByName(orgId, name)) return conflict();
  let source;
  try {
    source = await prisma.source.create({
      data: { orgId, name, contactName: contactName || null, contactEmail: contactEmail || null },
    });
  } catch (error) {
    // Lost a race for the same name: still the 409 the pre-read would give.
    if ((error as { code?: string })?.code === 'P2002') return conflict();
    throw error;
  }
  await logActivity({
    action: 'source.created',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'source',
    targetId: source.id,
    detail: source.name,
    request,
  });
  return NextResponse.json({ source }, { status: 201 });
  });
}
