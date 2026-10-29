import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { runFeed } from '@/lib/rosterFeedRunner';
import { loadRun, runResponse } from '@/lib/rosterFeedAdmin';

// "Approve and apply" (#1967) for a run the deactivation ceiling stopped
// (#1966). The approval lifts THAT valve only — the row floor, the grace
// period, the last-admin and break-glass refusals all still hold — and only
// for the file the admin looked at: the run is re-fetched with the stopped
// run's hash expected, and a file that changed meanwhile is refused. Audited
// before it runs, with the approver stamped on the run.

type Ctx = { params: Promise<{ id: string; runId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const gate = await requirePermission('org.integrations.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id, runId } = await params;
  return withTenantScope(session, async () => {
    const orgId = await settingsOrgOf(session);
    const run = await loadRun(id, runId, orgId);
    if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (run.status !== 'ABORTED_SAFETY' || run.dryRun) {
      return NextResponse.json({ error: 'Only a stopped run can be approved.', code: 'not_stopped' }, { status: 409 });
    }
    if (!run.safetyReason?.startsWith('deactivation_ceiling')) {
      // A file below the row floor is not a file to approve: fix the export.
      return NextResponse.json({ error: 'This valve cannot be approved.', code: 'not_approvable' }, { status: 409 });
    }
    await prisma.rosterRun.updateMany({ where: { id: runId, orgId }, data: { approvedById: session.user.id } });
    await logActivity({
      action: 'roster.run_approved',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'roster_run',
      targetId: runId,
      detail: (run.safetyReason ?? '').slice(0, 191),
      request,
    });
    return runResponse(await runFeed(id, { approved: true, expectFileHash: run.fileHash }));
  });
}
