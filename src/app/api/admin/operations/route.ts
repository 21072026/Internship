import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { resolveQueueScope } from '@/lib/mailQueueAdmin';
import { operationsView } from '@/lib/operationsConsole';
import { withRequestScope } from '@/lib/requestContext';

export const dynamic = 'force-dynamic';

// GET — the operations console (#1607): every schedule with its last run,
// next slot and alarms, the failed-run counts and (world scope) the leases.
//
// WHO. The job tables are the deployment's, so the console takes the mail
// queue's operator rule (`queueScopeFor()`, src/lib/mailOpsRule.ts): a super
// admin sees their world, the default organization's ADMIN that
// organization's runs, every other caller is refused HERE — hiding the nav
// entry is not the control. No session → 401; a session of any other role, or
// a tenant ADMIN → 403.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('analytics.read', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;
    const scope = await resolveQueueScope(session);
    if (!scope) return NextResponse.json({ error: 'Forbidden', code: 'operations_operator_only' }, { status: 403 });
    return NextResponse.json(await operationsView(scope));
  });
}
