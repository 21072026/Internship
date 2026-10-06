import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { subscriptionAdminOrg } from '@/lib/reportSubscriptionAdmin';
import { sendReportSubscription } from '@/lib/jobs/reportSubscriptions';

// POST — send me a test (#1905): this subscription's report, rendered exactly
// as the recipient will get it (their language, their format), but mailed to
// the ADMIN asking. Recorded in the delivery history under a `test-…` period,
// so it never takes the place of a real period's send.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const gate = await subscriptionAdminOrg(session);
  if ('response' in gate) return gate.response;
  const limited = enforceRateLimit(request, 'report-sub-test', { limit: 10, windowMs: 10 * 60 * 1000, subject: session.user.id });
  if (limited) return limited;
  const sub = await prisma.reportSubscription.findFirst({ where: { id: (await params).id, orgId: gate.orgId } });
  if (!sub) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const result = await sendReportSubscription(sub, { periodKey: `test-${Date.now()}`, to: { userId: session.user.id } });
  return NextResponse.json(result, { status: result.outcome === 'FAILED' ? 502 : 200 });
}
