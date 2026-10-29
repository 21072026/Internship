import { NextResponse } from 'next/server';
import { withTenantScope } from '@/lib/orgContext';
import { previewJourney } from '@/lib/programJourney';
import { journeyProgramFor } from '@/lib/programJourneyAdmin';
import { requirePermission } from '@/lib/authz';


// GET ?relationId= — the dry-run timeline of the journey against one of the
// programme's pairs (#1853): each step's computed date and what the sweep would
// do with it. A GET on purpose, and read-only by construction: previewJourney()
// never claims a ProgramStepRun, so previewing can never deliver anything.
// `?at=` pins the clock (the same convention as GET /api/cron).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('program.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
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
