import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { anonymizeUser, hardDeleteUser } from '@/lib/accountErasure';
import { withTenantScope } from '@/lib/orgContext';

const bodySchema = z.object({
  mode: z.enum(['anonymize', 'delete']),
  // Extra confirmation gate: the admin must type the target's current full
  // name exactly. This is a misclick guard, not authentication.
  confirmName: z.string().min(1),
  // Step-up authentication: the admin re-enters their OWN password. The
  // self-service delete asks the account holder for theirs; the admin path has
  // no equivalent, so a hijacked admin session could otherwise destroy
  // accounts without ever proving who is behind the keyboard. Note it is
  // deliberately the *admin's* password — asking for the target's, which no
  // admin can know, is what made the impersonated account page a dead end.
  adminPassword: z.string().min(1),
});

// POST — admin-initiated erasure of another user's account (EPIC: GDPR data
// retention). Reachable from the candidate detail page and the admin user list.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // An impersonation session carries the target user's role, so it cannot pass
  // the check above today — assert it anyway, so erasure can never be attributed
  // to an admin who was merely being impersonated.
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot erase accounts while impersonating' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
  const { id } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { mode, confirmName, adminPassword } = parsed.data;

  if (id === session.user.id) {
    return NextResponse.json({ error: 'Use your own account settings to delete your account' }, { status: 400 });
  }

  const admin = await prisma.user.findUnique({ where: { id: session.user.id }, select: { password: true } });
  if (!admin || !(await bcrypt.compare(adminPassword, admin.password))) {
    return NextResponse.json({ error: 'Your password is incorrect' }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, fullName: true } });
  if (!target) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // Admin accounts are out of scope by design: one admin quietly erasing
  // another is a governance problem, and it would also let the last admin
  // account disappear. Demote the account first, or let its owner delete it.
  if (target.role === 'ADMIN') {
    return NextResponse.json({ error: 'Admin accounts cannot be erased here — change the role first' }, { status: 400 });
  }
  // Anonymizing keeps the row and its pipeline history, which only means
  // something for a candidate; other roles get permanent deletion or nothing.
  if (mode === 'anonymize' && target.role !== 'MENTEE') {
    return NextResponse.json({ error: 'Only candidate accounts can be anonymized' }, { status: 400 });
  }
  if (confirmName.trim() !== target.fullName) {
    return NextResponse.json({ error: 'Name does not match — erasure cancelled' }, { status: 400 });
  }

  try {
    if (mode === 'delete') {
      await hardDeleteUser(id);
    } else {
      await anonymizeUser(id);
    }
  } catch (error) {
    // Usually a foreign key that neither cascades nor is detached in
    // hardDeleteUser. Say so instead of returning a bare 500, and point at the
    // fallback that always works for candidates.
    console.error('Admin erase failed:', error);
    return NextResponse.json({ error: 'Could not erase this account — it still has linked records' }, { status: 409 });
  }

  await logActivity({
    action: mode === 'delete' ? 'user.erase.delete' : 'user.erase.anonymize',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: id,
    // Who and what is gone: after a hard delete the target row no longer exists,
    // so the log line is the only remaining record of it.
    detail: `${target.role} ${target.fullName}`,
    request,
  });

  return NextResponse.json({ ok: true });
  });
}
