import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { mergeUsers, MergeError } from '@/lib/mergeUsers';
import { withTenantScope } from '@/lib/orgContext';

const bodySchema = z.object({
  primaryId: z.string().min(1),
  duplicateId: z.string().min(1),
  // Extra confirmation gate: the admin must type the DUPLICATE record's full
  // name exactly — that is the row that gets deleted. Misclick guard, not
  // authentication.
  confirmName: z.string().min(1),
  // Step-up authentication, same rationale as the admin erase route: a merge
  // deletes a user row, so a hijacked admin session must not be enough.
  adminPassword: z.string().min(1),
});

// Every MergeError code is a caller problem, not a server fault — map to 4xx.
const MERGE_ERROR_STATUS: Record<MergeError['code'], number> = {
  same_user: 400,
  not_found: 404,
  org_mismatch: 400,
  not_mentee: 400,
  erased: 400,
  linked_by_mentorship: 409,
};

// POST — merge a duplicate candidate into a primary one (#841). The single
// most destructive endpoint after erasure: the duplicate row is deleted after
// everything attached to it is re-pointed (see src/lib/mergeUsers.ts).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // An impersonation session carries the target user's role, so it cannot pass
  // the check above today — assert it anyway, so a merge can never be attributed
  // to an admin who was merely being impersonated.
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot merge accounts while impersonating' }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { primaryId, duplicateId, confirmName, adminPassword } = parsed.data;

  const admin = await prisma.user.findUnique({ where: { id: session.user.id }, select: { password: true } });
  if (!admin || !(await bcrypt.compare(adminPassword, admin.password))) {
    return NextResponse.json({ error: 'Your password is incorrect' }, { status: 400 });
  }

  const duplicate = await prisma.user.findUnique({ where: { id: duplicateId }, select: { fullName: true } });
  if (!duplicate) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (confirmName.trim() !== duplicate.fullName) {
    return NextResponse.json({ error: 'name_mismatch' }, { status: 400 });
  }

  let result;
  try {
    result = await mergeUsers({ primaryId, duplicateId });
  } catch (error) {
    if (error instanceof MergeError) {
      return NextResponse.json({ error: error.code }, { status: MERGE_ERROR_STATUS[error.code] });
    }
    console.error('Merge failed:', error);
    return NextResponse.json({ error: 'Merge failed' }, { status: 500 });
  }

  const totalMoved = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: 'USER_MERGE',
      targetId: primaryId,
      detail: JSON.stringify({ duplicateId, duplicateEmail: result.duplicateEmail, counts: result.counts }),
    },
  });
  await logActivity({
    action: 'user.merge',
    level: 'warning',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: primaryId,
    // The duplicate row no longer exists — this line is the durable record of
    // which account was absorbed and how much history moved with it.
    detail: `absorbed ${result.duplicateEmail} (${totalMoved} rows moved)`,
    request,
  });

  return NextResponse.json({ ok: true, counts: result.counts });
  });
}
