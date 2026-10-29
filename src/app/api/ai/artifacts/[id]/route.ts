import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { ARTIFACT_VISIBILITIES, canReadArtifact, toArtifactDto } from '@/lib/ai/artifacts';

const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404 });

// GET — one artefact, if the caller may read it (#2044). A private one is a
// 403 for someone who can otherwise see that it exists (the mentee's mentor,
// an admin); a 404 for everyone else.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const a = await prisma.aiArtifact.findUnique({ where: { id } });
    if (!a) return notFound();
    const viewer = { id: session.user.id, role: session.user.role, orgId: session.user.orgId ?? null };
    if (!(await canReadArtifact(viewer, a))) {
      // Saying "forbidden" only to someone already related to the subject: a
      // stranger cannot use the status code to learn that an id exists.
      // "Admin" is the permission layer's answer (#1571).
      const actor = await actorFromSession(session);
      const isAdmin = !!actor && (await can(actor, 'user.read', undefined, session));
      const related = isAdmin || (a.subjectUserId && (await prisma.mentorshipRelation.findFirst({ where: { mentorId: session.user.id, menteeId: a.subjectUserId }, select: { id: true } })));
      return related ? NextResponse.json({ error: 'Forbidden' }, { status: 403 }) : notFound();
    }
    return NextResponse.json({ artifact: toArtifactDto(a, session.user.id) });
  });
}

const patchSchema = z.object({ visibility: z.enum(ARTIFACT_VISIBILITIES) }).strict();

// PATCH { visibility } — share with the mentor (or the admin), or take it back.
// Only the subject decides: it is their data. Recorded in the audit log.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const a = await prisma.aiArtifact.findUnique({ where: { id } });
    if (!a || a.subjectUserId !== session.user.id) return notFound();
    const updated = await prisma.aiArtifact.update({ where: { id }, data: { visibility: parsed.data.visibility } });
    await prisma.auditLog
      .create({ data: { actorId: session.user.id, action: 'ai_artifact.visibility', targetId: id, detail: JSON.stringify({ from: a.visibility, to: updated.visibility, taskId: a.taskId }) } })
      .catch(() => {});
    return NextResponse.json({ artifact: toArtifactDto(updated, session.user.id) });
  });
}
