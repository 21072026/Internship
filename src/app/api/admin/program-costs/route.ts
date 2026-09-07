import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';

// Programme cost ledger (#1892) — the cost side of the ROI report.
//
// ADMIN only, and deliberately so: what a programme spends is among the most
// commercially sensitive data in the product. A mentor has no reason to see the
// coordinator's salary line and a mentee certainly does not.
//
// Every read and write is scoped to the caller's org TWICE — once by the
// tenant middleware (ProgramCost is registered in TENANT_MODELS) and once by an
// explicit `orgId` in the `where`. The middleware only engages when
// MT_ENFORCE_ISOLATION is on, so the explicit filter is what actually protects
// single-tenant production today; the registration is what protects it after
// the flag flips. Mutations go through updateMany/deleteMany with orgId in the
// filter rather than update/delete by id, so another tenant's row id simply
// matches nothing instead of being modified.

// MySQL INT, which is what `amountMinor Int` compiles to. Anything larger
// silently truncates on write — a €30m cost line landing as a negative number
// is the exact class of bug this module's integer-money rule exists to avoid.
const INT_MAX = 2_147_483_647;

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'ISO 4217 code')
  .transform((code) => code.toUpperCase());

// A calendar day, not an instant: `periodStart`/`periodEnd` are `@db.Date`, and
// accepting a full timestamp would let a browser in UTC+3 file a cost against
// the previous day.
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'not a real date');

const toUtcDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

// A key, not a sentence — the human-readable name is `label`. Free-form so a
// tenant's own chart of accounts fits (see the model comment), constrained in
// shape so it stays usable as a grouping key.
const categorySchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Z0-9_]+$/, 'uppercase key');

const createSchema = z
  .object({
    cohortId: z.string().min(1).max(60).nullable().optional(),
    category: categorySchema,
    label: z.string().trim().min(1).max(200),
    amountMinor: z.number().int().min(-INT_MAX).max(INT_MAX),
    currency: currencySchema,
    periodStart: dateSchema,
    periodEnd: dateSchema,
    note: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => toUtcDate(value.periodStart) <= toUtcDate(value.periodEnd), {
    message: 'periodStart must not be after periodEnd',
    path: ['periodEnd'],
  });

const patchSchema = createSchema.innerType().partial().extend({ id: z.string().min(1).max(60) }).strict();

const deleteSchema = z.object({ id: z.string().min(1).max(60) }).strict();

async function adminSession() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

export async function GET(request: Request) {
  const session = await adminSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const params = new URL(request.url).searchParams;
    const cohortId = params.get('cohortId');
    // Overlap, not containment: an annual subscription belongs to every window
    // it spans, which is the whole reason the period is two dates.
    const from = params.get('from');
    const to = params.get('to');

    const costs = await prisma.programCost.findMany({
      where: {
        orgId,
        ...(cohortId ? { cohortId } : {}),
        ...(to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? { periodStart: { lte: toUtcDate(to) } } : {}),
        ...(from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? { periodEnd: { gte: toUtcDate(from) } } : {}),
      },
      orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return NextResponse.json({ costs });
  });
}

export async function POST(request: Request) {
  const session = await adminSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const data = parsed.data;

    // A cohort from another tenant would otherwise attach this org's spend to
    // somebody else's programme.
    if (data.cohortId) {
      const cohort = await prisma.cohort.findFirst({ where: { id: data.cohortId, orgId }, select: { id: true } });
      if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });
    }

    const cost = await prisma.programCost.create({
      data: {
        orgId,
        cohortId: data.cohortId ?? null,
        category: data.category,
        label: data.label,
        amountMinor: data.amountMinor,
        currency: data.currency,
        periodStart: toUtcDate(data.periodStart),
        periodEnd: toUtcDate(data.periodEnd),
        note: data.note ?? null,
        createdById: session.user.id,
      },
    });

    await logActivity({
      action: 'program_cost.create',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'program_cost',
      targetId: cost.id,
      // The amount, never the note: the note is free text an admin wrote and
      // the activity log is read by more people than the ledger is.
      detail: `${cost.category} ${cost.amountMinor} ${cost.currency}`,
      request,
    });

    return NextResponse.json({ cost }, { status: 201 });
  });
}

export async function PATCH(request: Request) {
  const session = await adminSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { id, ...fields } = parsed.data;

    const existing = await prisma.programCost.findFirst({ where: { id, orgId } });
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const periodStart = fields.periodStart ? toUtcDate(fields.periodStart) : existing.periodStart;
    const periodEnd = fields.periodEnd ? toUtcDate(fields.periodEnd) : existing.periodEnd;
    if (periodStart > periodEnd) {
      return NextResponse.json(
        { error: 'Validation failed', details: { formErrors: ['periodStart must not be after periodEnd'] } },
        { status: 400 }
      );
    }

    if (fields.cohortId) {
      const cohort = await prisma.cohort.findFirst({ where: { id: fields.cohortId, orgId }, select: { id: true } });
      if (!cohort) return NextResponse.json({ error: 'Cohort not found' }, { status: 404 });
    }

    await prisma.programCost.updateMany({
      where: { id, orgId },
      data: {
        ...(fields.cohortId !== undefined ? { cohortId: fields.cohortId } : {}),
        ...(fields.category !== undefined ? { category: fields.category } : {}),
        ...(fields.label !== undefined ? { label: fields.label } : {}),
        ...(fields.amountMinor !== undefined ? { amountMinor: fields.amountMinor } : {}),
        ...(fields.currency !== undefined ? { currency: fields.currency } : {}),
        ...(fields.periodStart !== undefined ? { periodStart } : {}),
        ...(fields.periodEnd !== undefined ? { periodEnd } : {}),
        ...(fields.note !== undefined ? { note: fields.note } : {}),
      },
    });
    const cost = await prisma.programCost.findFirst({ where: { id, orgId } });

    await logActivity({
      action: 'program_cost.update',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'program_cost',
      targetId: id,
      detail: `${existing.amountMinor} ${existing.currency} -> ${cost?.amountMinor} ${cost?.currency}`,
      request,
    });

    return NextResponse.json({ cost });
  });
}

export async function DELETE(request: Request) {
  const session = await adminSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const orgId = resolveOrgId(session);
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }

    // Deleting a cost line is safe in a way deleting a Placement is not: a cost
    // is an input to a report, not an accounting record of something that
    // happened to a person. A mistyped line should leave no trace in the total.
    const removed = await prisma.programCost.deleteMany({ where: { id: parsed.data.id, orgId } });
    if (removed.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await logActivity({
      action: 'program_cost.delete',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'program_cost',
      targetId: parsed.data.id,
      request,
    });

    return NextResponse.json({ ok: true });
  });
}
