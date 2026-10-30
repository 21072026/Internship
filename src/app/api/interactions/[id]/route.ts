import { NextResponse } from 'next/server';
import { getServerSession, type Session } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { actorFromSession, can, type Permission } from '@/lib/authz';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { updateInteractionSchema } from '@/lib/interactionSchema';


/** Does the caller act as an admin here? The permission rule answers, not the role string (#1571). */
async function actsAsAdmin(session: Session, perm: Permission): Promise<boolean> {
  const actor = await actorFromSession(session);
  return !!actor && (await can(actor, perm, undefined, session));
}

async function getInteractionAndVerifyAccess(
  id: string,
  userId: string,
  isAdmin: boolean,
  callerOrgId: string | null
) {
  const interaction = await prisma.interactionLog.findUnique({
    where: { id },
    include: { relation: true },
  });

  if (!interaction) return { interaction: null, authorized: false };
  // InteractionLog has no orgId: its tenant is its relation's, and neither the
  // top-level lookup nor the nested include is scoped by the middleware. A log
  // on another tenant's relation reads as not found — 404, never 403, so the id
  // is not confirmed to exist (#2542). Checked before any write below.
  if (!(await inCallerTenant(interaction.relation.orgId, callerOrgId))) {
    return { interaction: null, authorized: false };
  }

  const authorized =
    isAdmin || interaction.relation.mentorId === userId;

  return { interaction, authorized };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { interaction, authorized } = await getInteractionAndVerifyAccess(
      id,
      session.user.id,
      await actsAsAdmin(session, 'program.read'),
      resolveOrgId(session)
    );

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    if (!authorized && interaction.relation.menteeId !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json({ interaction });
  } catch (error) {
    console.error('Get interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { interaction, authorized } = await getInteractionAndVerifyAccess(
      id,
      session.user.id,
      await actsAsAdmin(session, 'relation.write'),
      resolveOrgId(session)
    );

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateInteractionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // The same fields the create route takes (src/lib/interactionSchema.ts,
    // #1356), so a Call keeps its type and a subject can be corrected. An
    // emptied subject is stored as NULL, as the create path stores a missing one.
    const { date, subject, ...rest } = parsed.data;
    const updated = await prisma.interactionLog.update({
      where: { id },
      data: {
        ...rest,
        ...(date !== undefined ? { date: new Date(date) } : {}),
        ...(subject !== undefined ? { subject: subject?.trim() ? subject.trim() : null } : {}),
      },
    });

    return NextResponse.json({ interaction: updated });
  } catch (error) {
    console.error('Update interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { interaction, authorized } = await getInteractionAndVerifyAccess(
      id,
      session.user.id,
      await actsAsAdmin(session, 'relation.write'),
      resolveOrgId(session)
    );

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    if (!authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await prisma.interactionLog.delete({ where: { id } });

    return NextResponse.json({ message: 'Interaction deleted successfully' });
  } catch (error) {
    console.error('Delete interaction error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
