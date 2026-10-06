import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { SUBSCRIPTION_SELECT, subscriptionAdminOrg, subscriptionWriteProblem } from '@/lib/reportSubscriptionAdmin';

// PATCH / DELETE one report subscription (#1905). The row must be the caller's
// org's — another tenant's id is a 404, never a 403, so ids cannot be probed.
// The recipient is fixed once created: changing who receives a report is a new
// subscription (and a new unsubscribe link), not an edit of someone else's.

const patchSchema = z.object({
  cadence: z.string().max(16).optional(),
  dayOfWeek: z.number().int().nullable().optional(),
  dayOfMonth: z.number().int().nullable().optional(),
  hour: z.number().int().optional(),
  locale: z.string().max(8).optional(),
  format: z.string().max(16).optional(),
  isActive: z.boolean().optional(),
});

async function own(id: string, orgId: string) {
  return prisma.reportSubscription.findFirst({ where: { id, orgId } });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const gate = await subscriptionAdminOrg(session);
  if ('response' in gate) return gate.response;
  const sub = await own((await params).id, gate.orgId);
  if (!sub) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const cadence = parsed.data.cadence ?? sub.cadence;
  const next = {
    reportKey: sub.reportKey,
    cadence,
    dayOfWeek: cadence === 'WEEKLY' ? (parsed.data.dayOfWeek !== undefined ? parsed.data.dayOfWeek : sub.dayOfWeek) : null,
    dayOfMonth: cadence === 'WEEKLY' ? null : (parsed.data.dayOfMonth !== undefined ? parsed.data.dayOfMonth : sub.dayOfMonth),
    hour: parsed.data.hour ?? sub.hour,
    locale: parsed.data.locale ?? sub.locale,
    format: parsed.data.format ?? sub.format,
    recipientUserId: sub.recipientUserId,
    recipientEmail: sub.recipientEmail,
  };
  // Re-checked in full: switching on an old subscription must meet today's
  // rules (the recipient may have left, the plan may have lost REPORT_EXPORT).
  const problem = await subscriptionWriteProblem(gate.orgId, next);
  if (problem) return problem;

  const updated = await prisma.reportSubscription.update({
    where: { id: sub.id },
    data: {
      cadence: next.cadence,
      dayOfWeek: next.dayOfWeek,
      dayOfMonth: next.dayOfMonth,
      hour: next.hour,
      locale: next.locale,
      format: next.format,
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
    },
    select: SUBSCRIPTION_SELECT,
  });
  await logActivity({
    action: 'report_subscription.updated',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'report_subscription',
    targetId: sub.id,
    orgId: gate.orgId,
    request,
  });
  return NextResponse.json({ subscription: updated });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const gate = await subscriptionAdminOrg(session);
  if ('response' in gate) return gate.response;
  const sub = await own((await params).id, gate.orgId);
  if (!sub) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await prisma.reportSubscription.delete({ where: { id: sub.id } });
  await logActivity({
    action: 'report_subscription.deleted',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'report_subscription',
    targetId: sub.id,
    orgId: gate.orgId,
    request,
  });
  return NextResponse.json({ ok: true });
}
