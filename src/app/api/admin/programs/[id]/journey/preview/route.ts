import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { previewJourney } from '@/lib/programJourney';
import { journeyProgramFor } from '@/lib/programJourneyAdmin';


async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

// GET ?relationId= — the dry-run timeline of the journey against one of the
// programme's pairs (#1853): each step's computed date and what the sweep would
// do with it. A GET on purpose, and read-only by construction: previewJourney()
// never claims a ProgramStepRun, so previewing can never deliver anything.
// `?at=` pins the clock (the same convention as GET /api/cron).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const auth = await journeyProgramFor(session, (await params).id);
  if ('refusal' in auth) return auth.refusal;
  const { program } = auth;
  return await withTenantScope(session, async () => {
    const url = new URL(request.url);
    const relationId = url.searchParams.get('relationId') ?? '';
    const at = url.searchParams.get('at');
    const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : new Date();
    const timeline = relationId ? await previewJourney(program.id, relationId, now) : null;
    if (!timeline) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({
      at: now.toISOString(),
      timeline: timeline.map(({ stepId, entry }) => ({ stepId, status: entry.status, dueAt: entry.dueAt?.toISOString() ?? null, reason: entry.reason })),
    });
  });
}
