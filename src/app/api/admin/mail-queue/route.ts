import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { mailQueueView, resolveQueueScope } from '@/lib/mailQueueAdmin';
import { withRequestScope } from '@/lib/requestContext';

export const dynamic = 'force-dynamic';

// GET — the mail queue as the admin Queue tab shows it (#2953): counts per
// lane and state, the dead-letter list, the waiting list and the relay pause.
//
// WHO. The queue is the deployment's, both products and every tenant, so it
// is not a tenant admin's screen (`queueScopeFor()`, src/lib/mailOpsRule.ts):
//   • a super admin sees every row of their world, and today's count against
//     the daily cap;
//   • the ADMIN of the deployment's default organization sees that
//     organization's rows and the rows with no organization (operator alerts,
//     mail to an address with no account yet) — never another tenant's;
//   • every other caller: 401 / 403.
// No row carries an address or a subject: lane, category, world, state,
// attempts, a reason code and a 12-character prefix of the recipient's hash.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const scope = await resolveQueueScope(session);
    if (!scope) return NextResponse.json({ error: 'Forbidden', code: 'mail_queue_operator_only' }, { status: 403 });
    // `?probe=1`: may this caller open the tab at all? The settings page asks
    // before drawing the tab, and the answer must not cost the full view.
    if (new URL(request.url).searchParams.get('probe') === '1') return NextResponse.json({ ok: true, scope: scope.kind });
    return NextResponse.json(await mailQueueView(scope));
  });
}
