import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { projectInCallerTenant } from '@/lib/projectAccess';
import { canManageProjectTeam, nonManagerStatus } from '@/lib/projectTeamRule';
import { listTeamCandidates, loadTeamProject } from '@/lib/projectTeamAccess';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';

// GET — the people this project's manager may add, each with the seats they
// may take (#2272). Mentee-safe: id, name and account role only, and only the
// set `addableSeats()` admits — the same call the member POST makes, so the
// picker never offers someone the write would refuse. An ADMIN gets an empty
// list here; their picker is `/api/users`, which carries the admin tier's
// own program scope.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'projects');
  if (capGate) return capGate;
  return await withTenantScope(session, async () => {
    const { id } = await params;
    if (!(await projectInCallerTenant(session, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const project = await loadTeamProject(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canManageProjectTeam(session.user, project)) {
      return nonManagerStatus(session.user.id, project) === 403
        ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        : NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const candidates = await listTeamCandidates(session, new Set(project.members.map((m) => m.userId)));
    return NextResponse.json({ candidates });
  });
}
