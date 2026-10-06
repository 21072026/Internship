import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { SUBSCRIPTION_SELECT, subscriptionAdminOrg, subscriptionWriteProblem } from '@/lib/reportSubscriptionAdmin';

// /api/admin/report-subscriptions (#1905) — the org's scheduled reports.
// GET lists them with their recent deliveries; POST creates one. ADMIN and
// ADVANCED_ANALYTICS (src/lib/reportSubscriptionAdmin.ts); every write-time
// rule is checked there, before anything is stored.

const createSchema = z.object({
  reportKey: z.string().min(1).max(64),
  cadence: z.string().max(16),
  dayOfWeek: z.number().int().nullable().optional(),
  dayOfMonth: z.number().int().nullable().optional(),
  hour: z.number().int(),
  locale: z.string().max(8),
  format: z.string().max(16),
  recipientUserId: z.string().max(64).nullable().optional(),
  recipientEmail: z.string().trim().toLowerCase().max(320).nullable().optional(),
  recipientName: z.string().trim().max(191).nullable().optional(),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const gate = await subscriptionAdminOrg(session);
  if ('response' in gate) return gate.response;
  const subscriptions = await prisma.reportSubscription.findMany({
    where: { orgId: gate.orgId },
    orderBy: { createdAt: 'desc' },
    select: SUBSCRIPTION_SELECT,
  });
  return NextResponse.json({ subscriptions });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const gate = await subscriptionAdminOrg(session);
  if ('response' in gate) return gate.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const d = parsed.data;
  const input = {
    ...d,
    dayOfWeek: d.cadence === 'WEEKLY' ? (d.dayOfWeek ?? null) : null,
    dayOfMonth: d.cadence === 'WEEKLY' ? null : (d.dayOfMonth ?? null),
    recipientUserId: d.recipientUserId || null,
    recipientEmail: d.recipientEmail || null,
  };
  const problem = await subscriptionWriteProblem(gate.orgId, input);
  if (problem) return problem;

  const created = await prisma.reportSubscription.create({
    data: {
      orgId: gate.orgId,
      reportKey: input.reportKey,
      cadence: input.cadence,
      dayOfWeek: input.dayOfWeek,
      dayOfMonth: input.dayOfMonth,
      hour: input.hour,
      locale: input.locale,
      format: input.format,
      recipientUserId: input.recipientUserId,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientEmail ? d.recipientName || null : null,
      createdById: session.user.id,
    },
    select: SUBSCRIPTION_SELECT,
  });
  await logActivity({
    action: 'report_subscription.created',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'report_subscription',
    targetId: created.id,
    detail: `${input.reportKey} ${input.cadence}`,
    orgId: gate.orgId,
    request,
  });
  return NextResponse.json({ subscription: created }, { status: 201 });
}
