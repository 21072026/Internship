import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { draftActionRoute } from '@/lib/outboxRoute';

export const dynamic = 'force-dynamic';

const schema = z.object({
  // An absolute instant (ISO 8601 with an offset). The page converts the
  // operator's local date and time in their own time zone; the server stores UTC.
  at: z.string().datetime({ offset: true }),
});

// POST — Schedule a held mail: the draft becomes SCHEDULED and the mail goes onto the mail queue for that time (#2960).
// The time must be in the future, within 30 days and before the draft expires
// (`actionAllowed()` in src/lib/outboundApprovalRule.ts); otherwise 409 with the
// reason code.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { id } = await params;
    return draftActionRoute(session, id, 'schedule', request, new Date(parsed.data.at));
  });
}
