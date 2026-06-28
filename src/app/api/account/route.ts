import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { passwordSchema } from '@/lib/password';
import { logActivity } from '@/lib/activity';

const schema = z.object({
  email: z.string().email().optional(),
  currentPassword: z.string().optional(),
  newPassword: passwordSchema.optional(),
});

export async function PUT(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { email, currentPassword, newPassword } = parsed.data;

    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const data: { email?: string; password?: string } = {};

    if (email && email !== user.email) {
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken) {
        return NextResponse.json({ error: 'Email already in use' }, { status: 409 });
      }
      data.email = email;
    }

    if (newPassword) {
      if (!currentPassword || !(await bcrypt.compare(currentPassword, user.password))) {
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
      }
      data.password = await bcrypt.hash(newPassword, 12);
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ message: 'Nothing to update' });
    }

    await prisma.user.update({ where: { id: user.id }, data });
    // Note: email/password changes apply on next sign-in (the JWT keeps the old email until then).
    return NextResponse.json({ message: 'Account updated', emailChanged: !!data.email });
  } catch (error) {
    console.error('Account update error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE — self-service account deletion.
export async function DELETE() {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Don't allow deleting an account while impersonating it.
    if (session.user.impersonatorId) {
      return NextResponse.json({ error: 'Cannot delete an account while impersonating it' }, { status: 400 });
    }

    const id = session.user.id;

    // The last remaining admin can't delete themselves.
    if (session.user.role === 'ADMIN') {
      const admins = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (admins <= 1) {
        return NextResponse.json({ error: 'The last admin account cannot be deleted' }, { status: 400 });
      }
    }

    // Remove rows that reference the user without a cascade, then the user
    // (cvFile + tokens cascade via their onDelete: Cascade relations).
    await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ mentorId: id }, { menteeId: id }] } });
    await prisma.statusChange.deleteMany({ where: { changedById: id } });
    await prisma.user.delete({ where: { id } });

    await logActivity({ action: 'account.delete', level: 'warning', actorId: id, actorEmail: session.user.email ?? null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Account delete error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
