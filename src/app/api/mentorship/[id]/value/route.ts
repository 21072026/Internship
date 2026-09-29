import { NextResponse } from 'next/server';
import { getServerSession, type Session } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { logActivity } from '@/lib/activity';
import { isDealValueEnabled, validateDealValue } from '@/lib/dealValue';

// GET / PUT /api/mentorship/<id>/value — a funnel record's ESTIMATED monthly
// value (#2422, story #2393).
//
// Its own endpoint and its own table (model RelationValue): the figure is the
// operator's view of an account, and the relation's scalars travel to the
// record's lead, company user and source on many read paths (#1801). Nothing
// here is ever part of a relation payload; this route is the only reader that
// hands it to a browser, and it answers only the two people who may edit it.
//
// WHO: an ADMIN of the record's tenant, or the record's owner (`mentorId` —
// what the MARKETING overlay calls the owner). Everyone else is 403, the lead on
// the record included. Another tenant's record is 404, like a missing one.
//
// WHERE: a vertical that works with deal values (isDealValueEnabled — the
// pipeline without the mentorship module, i.e. MARKETING). An INTERNSHIP
// tenant values placements through the ROI model instead, so this answers 404
// there and its screens never show the editor.
//
// WHAT: `valueMinor` is an INTEGER in minor units — a float is refused, never
// rounded — plus an allowed ISO 4217 code (default EUR); `null` clears the
// estimate (no row = "no estimate", which is not 0). A write is audited as an
// ActivityLog entry, which only admins read.

const bodySchema = z.object({
  // Loose here on purpose; validateDealValue() is the rule (integer, bounded).
  valueMinor: z.unknown(),
  currency: z.string().max(8).optional(),
});

/** The record, if the caller may see its value; otherwise the answer to send. */
async function loadForEditor(session: Session, id: string) {
  const relation = await prisma.mentorshipRelation.findFirst({
    where: withinTenant({ id }, await tenantWhere(session)),
    select: { id: true, orgId: true, mentorId: true, value: { select: { valueMinor: true, currency: true, source: true, updatedAt: true } } },
  });
  if (!relation) return { denied: NextResponse.json({ error: 'Relation not found' }, { status: 404 }) } as const;
  if (session.user.role !== 'ADMIN' && relation.mentorId !== session.user.id) {
    return { denied: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) } as const;
  }
  if (!isDealValueEnabled(await shellCapabilities(relation.orgId))) {
    return {
      denied: NextResponse.json({ error: 'Deal values are not used in this workspace', code: 'deal_value_unavailable' }, { status: 404 }),
    } as const;
  }
  return { relation } as const;
}

function payload(value: { valueMinor: number; currency: string; source: string; updatedAt: Date } | null) {
  return value
    ? { valueMinor: value.valueMinor, currency: value.currency, source: value.source, updatedAt: value.updatedAt.toISOString() }
    : { valueMinor: null, currency: null, source: null, updatedAt: null };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    try {
      const { id } = await params;
      const session = await getServerSession(authOptions);
      if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      return await withTenantScope(session, async () => {
        const loaded = await loadForEditor(session, id);
        if ('denied' in loaded) return loaded.denied;
        return NextResponse.json({ value: payload(loaded.relation.value) });
      });
    } catch (error) {
      console.error('Deal value read error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    try {
      const { id } = await params;
      const session = await getServerSession(authOptions);
      if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

      const denied = await requireCapability(session.user.orgId ?? null, 'pipeline');
      if (denied) return denied;

      return await withTenantScope(session, async () => {
        const loaded = await loadForEditor(session, id);
        if ('denied' in loaded) return loaded.denied;
        const { relation } = loaded;

        const body: unknown = await request.json().catch(() => null);
        const parsed = bodySchema.safeParse(body);
        if (!parsed.success || parsed.data.valueMinor === undefined) {
          return NextResponse.json({ error: 'Validation failed', code: 'invalid_amount' }, { status: 400 });
        }

        const before = relation.value;
        const describe = (v: { valueMinor: number; currency: string } | null) =>
          v ? `${v.valueMinor} ${v.currency}` : 'none';

        if (parsed.data.valueMinor === null) {
          if (before) await prisma.relationValue.deleteMany({ where: { relationId: relation.id } });
        } else {
          // A body without a currency keeps the stored one: `{valueMinor: 5000}`
          // on a CHF estimate is a new amount, not a silent switch to EUR.
          const checked = validateDealValue(parsed.data.valueMinor, parsed.data.currency ?? before?.currency);
          if (!checked.ok) {
            return NextResponse.json({ error: 'Invalid estimated value', code: checked.error }, { status: 400 });
          }
          if (before && before.valueMinor === checked.valueMinor && before.currency === checked.currency) {
            return NextResponse.json({ value: payload(before), changed: false });
          }
          const data = {
            valueMinor: checked.valueMinor,
            currency: checked.currency,
            source: 'MANUAL',
            updatedById: session.user.id,
          };
          await prisma.relationValue.upsert({
            where: { relationId: relation.id },
            // The relation's own org, explicitly — never whatever the context
            // happens to hold (see model RelationValue).
            create: { ...data, relationId: relation.id, orgId: relation.orgId },
            update: data,
          });
        }

        const after = await prisma.relationValue.findUnique({
          where: { relationId: relation.id },
          select: { valueMinor: true, currency: true, source: true, updatedAt: true },
        });
        if (describe(before) !== describe(after)) {
          await logActivity({
            action: 'deal.value_changed',
            actorId: session.user.id,
            actorEmail: session.user.email ?? null,
            targetType: 'relation',
            targetId: relation.id,
            detail: `${describe(before)} → ${describe(after)}`,
            request,
          });
        }
        return NextResponse.json({ value: payload(after), changed: describe(before) !== describe(after) });
      });
    } catch (error) {
      console.error('Deal value update error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
