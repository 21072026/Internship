import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { remindNow } from '@/lib/surveyReminders';

// "Remind now" (#1889): the named invitations of this survey, or every
// unanswered one when `invitationIds` is omitted. The same claim, cap (two)
// and 24-hour gap as the scheduled pass — a click can never be the third
// reminder, and a click racing the cron sends one mail. On an ANONYMOUS survey
// only the whole-survey form exists: its invitation ids are never handed out,
// so naming one is refused rather than guessed at.
const bodySchema = z.object({ invitationIds: z.array(z.string().min(1).max(64)).min(1).max(200).optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', issues: parsed.error.issues }, { status: 400 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const survey = await prisma.survey.findFirst({ where: withinTenant({ id }, await tenantWhere(session)), select: { id: true, anonymity: true } });
    if (!survey) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (survey.anonymity === 'ANONYMOUS' && parsed.data.invitationIds) {
      return NextResponse.json({ error: 'anonymous_bulk_only', code: 'anonymous_bulk_only' }, { status: 400 });
    }
    return NextResponse.json({ result: await remindNow(survey.id, parsed.data.invitationIds ?? null) });
  });
}
