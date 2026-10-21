import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { resolveQueueScope } from '@/lib/mailQueueAdmin';
import { listSuppressions } from '@/lib/emailSuppression';
import { withRequestScope } from '@/lib/requestContext';

export const dynamic = 'force-dynamic';

// GET — the bounce/complaint suppression list (#1692), for the admin mail
// settings' Suppressions tab. `?q=` searches the address, `?released=1` also
// lists delisted rows.
//
// WHO. The list is deployment-wide (one sending domain), so the mail queue's
// scope rule decides (`queueScopeFor()`, src/lib/mailOpsRule.ts): a super admin
// sees the addresses of their world, the default organization's ADMIN its own
// users' addresses; every other caller 401 / 403. Which rows a scope sees:
// src/lib/emailSuppression.ts § The admin list.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const scope = await resolveQueueScope(session);
    if (!scope) return NextResponse.json({ error: 'Forbidden', code: 'mail_queue_operator_only' }, { status: 403 });
    const url = new URL(request.url);
    return NextResponse.json(
      await listSuppressions(scope, { q: url.searchParams.get('q'), includeReleased: url.searchParams.get('released') === '1' }),
    );
  });
}
