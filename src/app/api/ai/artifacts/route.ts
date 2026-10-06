import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { canReadArtifact, toArtifactDto } from '@/lib/ai/artifacts';

// GET ?subjectUserId=&taskId= — the AI artefacts about a person that the caller
// may read (#2044), newest first. Without `subjectUserId`, the caller's own.
// Who may read what is canReadArtifact (src/lib/ai/artifacts.ts): the subject
// and the creator always; the subject's active mentor and the org's admins only
// what the subject shared. An artefact the caller may not read is simply absent.
const LIMIT = 20;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const subjectUserId = params.get('subjectUserId') || session.user.id;
  const taskId = params.get('taskId');
  return withTenantScope(session, async () => {
    const rows = await prisma.aiArtifact.findMany({
      where: { subjectUserId, ...(taskId ? { taskId } : {}), ...(subjectUserId === session.user.id ? {} : { visibility: { not: 'PRIVATE' } }) },
      orderBy: { createdAt: 'desc' },
      take: LIMIT,
    });
    const viewer = { id: session.user.id, role: session.user.role, orgId: session.user.orgId ?? null };
    const readable = [];
    for (const a of rows) if (await canReadArtifact(viewer, a)) readable.push(toArtifactDto(a, session.user.id));
    return NextResponse.json({ artifacts: readable });
  });
}
