import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { requireCapability } from '@/lib/capabilityGate';
import { SCREENING_ITEMS, parseChecklist, stampItem } from '@/lib/mentorScreeningRule';
import { TEXT_LIMITS } from '@/lib/textLimits';

// PATCH /api/mentor-applications/[id]/screening — the screening record (#1807).
// ADMIN only, inside the caller's tenant (another tenant's id is 404). Every
// field is optional: this records what was done, it never moves the status.
// A checklist tick is stamped with WHO and WHEN by the server — the body
// carries neither. Nothing written here reaches the applicant: no e-mail, no
// notification, and the activity log gets the item name, never the notes or
// the reference's details.

const schema = z
  .object({
    item: z.enum(SCREENING_ITEMS).optional(),
    done: z.boolean().optional(),
    interviewAt: z.string().datetime().nullable().optional(),
    interviewNotes: z.string().max(TEXT_LIMITS.mentorScreeningInterviewNotes).nullable().optional(),
    referenceName: z.string().max(TEXT_LIMITS.mentorScreeningReference).nullable().optional(),
    referenceContact: z.string().max(TEXT_LIMITS.mentorScreeningReference).nullable().optional(),
    referenceOutcome: z.string().max(TEXT_LIMITS.mentorScreeningReferenceOutcome).nullable().optional(),
  })
  .strict()
  .refine((v) => (v.item === undefined) === (v.done === undefined), { message: 'item_and_done_together' });

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const body = parsed.data;

  return await withTenantScope(session, async () => {
    const application = await prisma.mentorApplication.findFirst({
      where: withinTenant({ id }, await tenantWhere(session)),
      select: { id: true, screeningChecklist: true },
    });
    if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const data: Prisma.MentorApplicationUpdateInput = { screenedBy: { connect: { id: session.user.id } } };
    if (body.item && body.done !== undefined) {
      data.screeningChecklist = stampItem(parseChecklist(application.screeningChecklist), body.item, body.done, session.user.id, new Date()) as Prisma.InputJsonValue;
    }
    if (body.interviewAt !== undefined) data.interviewAt = body.interviewAt ? new Date(body.interviewAt) : null;
    for (const key of ['interviewNotes', 'referenceName', 'referenceContact', 'referenceOutcome'] as const) {
      const value = blankToNull(body[key]);
      if (value !== undefined) data[key] = value;
    }

    const updated = await prisma.mentorApplication.update({
      where: { id },
      data,
      select: {
        screeningChecklist: true,
        interviewAt: true,
        interviewNotes: true,
        referenceName: true,
        referenceContact: true,
        referenceOutcome: true,
        screenedById: true,
      },
    });

    // Which part changed, never what it says: the notes and the reference are
    // about people, and the activity log is read more widely than this screen.
    const changed = [
      ...(body.item ? [`${body.item}=${body.done ? 'done' : 'open'}`] : []),
      ...(['interviewAt', 'interviewNotes', 'referenceName', 'referenceContact', 'referenceOutcome'] as const).filter((k) => body[k] !== undefined),
    ];
    await logActivity({
      action: 'mentor_application.screening',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'mentor_application',
      targetId: id,
      detail: changed.join(' '),
      request,
    });

    return NextResponse.json({ screening: { ...updated, screeningChecklist: parseChecklist(updated.screeningChecklist) } });
  });
}
