import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { logActivity } from '@/lib/activity';
import { requireCapability } from '@/lib/capabilityGate';
import { inCallerTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantAdminIds } from '@/lib/tenantAdmins';

// The author's half of the two-person publish decision (#1098): the admin
// drafts an excerpt, the AUTHOR approves that exact wording here (or declines,
// which clears the draft so the admin must start over). Only the author of
// the evaluation can act — ownership enforced server-side.

// GET — my excerpts waiting for approval.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Testimonials are a mentorship module (the nav tags /admin/testimonials so).
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const pending = await prisma.evaluation.findMany({
    where: { authorId: session.user.id, publicExcerpt: { not: null }, excerptApprovedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, publicExcerpt: true, createdAt: true },
  });
  return NextResponse.json({ pending });
}

const schema = z.object({
  evaluationId: z.string().min(1),
  approve: z.boolean(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const evaluation = await prisma.evaluation.findUnique({
    where: { id: parsed.data.evaluationId },
    select: { id: true, authorId: true, publicExcerpt: true, relation: { select: { orgId: true } } },
  });
  // Same shape for missing and foreign rows: probing ids learns nothing. A row
  // hanging off another tenant's relation is foreign too (#2542), whoever
  // the author column names.
  if (
    !evaluation ||
    evaluation.authorId !== session.user.id ||
    (evaluation.relation && !(await inCallerTenant(evaluation.relation.orgId, resolveOrgId(session))))
  ) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!evaluation.publicExcerpt?.trim()) {
    return NextResponse.json({ error: 'Nothing to approve' }, { status: 400 });
  }

  if (parsed.data.approve) {
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { excerptApprovedAt: new Date() },
    });
  } else {
    // Declining wipes the draft — the admin redrafts rather than nagging the
    // author with the same wording again.
    await prisma.evaluation.update({
      where: { id: evaluation.id },
      data: { publicExcerpt: null, excerptApprovedAt: null, publishedAt: null, sharedPublicly: false },
    });
    // The author's own org's admins only (#2542): the query used to have no
    // org filter, so every tenant's admins heard of every decline.
    const adminIds = await tenantAdminIds(resolveOrgId(session));
    await Promise.all(adminIds.map((id) => notify(id, 'testimonial.declined', {}, '/admin/testimonials')));
  }
  await logActivity({
    action: parsed.data.approve ? 'testimonial.excerpt_approved' : 'testimonial.excerpt_declined',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'evaluation',
    targetId: evaluation.id,
    request,
  });
  return NextResponse.json({ ok: true });
}
