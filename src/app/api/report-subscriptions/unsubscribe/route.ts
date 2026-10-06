import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { verifyReportUnsubscribeToken } from '@/lib/reportSubscriptionTokens';

/**
 * POST — switch one report subscription off, straight from the e-mail (#1905).
 *
 * No session: the recipient may have no account (the point of the feature),
 * and the signed token is the authorisation — it can do nothing but this. A
 * POST from the page at /reports/unsubscribe, never the GET the mail links to,
 * so a link scanner cannot unsubscribe anyone.
 *
 * The answer is the same whether the subscription exists or not: pressing the
 * button twice must read as success, and the response must not reveal what is
 * on file.
 */
const schema = z.object({ token: z.string().min(1).max(512) });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'report-unsubscribe', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const id = verifyReportUnsubscribeToken(parsed.data.token);
  if (!id) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  const sub = await prisma.reportSubscription.findUnique({ where: { id }, select: { orgId: true, isActive: true } });
  if (sub?.isActive) {
    await prisma.reportSubscription.update({ where: { id }, data: { isActive: false } });
    await logActivity({
      orgId: sub.orgId,
      action: 'report_subscription.unsubscribed',
      actorId: null,
      actorEmail: null,
      targetType: 'report_subscription',
      targetId: id,
      detail: 'via one-click link',
      request,
    });
  }
  return NextResponse.json({ ok: true });
}
