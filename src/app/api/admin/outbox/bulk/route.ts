import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withRequestScope } from '@/lib/requestContext';
import { outboxActorFor } from '@/lib/outboxRoute';
import { applyBulkDraftAction } from '@/lib/outboundDrafts';
import { OUTBOUND_BULK_MAX } from '@/lib/outboundApprovalRule';

export const dynamic = 'force-dynamic';

const schema = z
  .object({
    action: z.enum(['send', 'schedule', 'discard']),
    ids: z.array(z.string().min(1).max(64)).min(1).max(OUTBOUND_BULK_MAX),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .refine((b) => b.action !== 'schedule' || !!b.at, { message: 'at is required to schedule' });

// POST — Send, schedule or discard several held mails at once (at most 50) (#2960).
// Each draft goes through the same guarded claim and audit row as the
// single-draft routes; the answer is an honest `{ done, skipped[] }` — a draft
// decided meanwhile, expired, or not visible to this caller is reported as
// skipped with its reason code, never retried.
export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const actor = await outboxActorFor(session);
    if (actor instanceof NextResponse) return actor;
    const { action, ids, at } = parsed.data;
    const result = await applyBulkDraftAction(actor, ids, action, { scheduledFor: at ? new Date(at) : null, request });
    return NextResponse.json(result);
  });
}
