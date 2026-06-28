import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessCv } from '@/lib/cvAccess';

// GET — download a user's CV (access-controlled).
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await params;
  if (!(await canAccessCv(session.user, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const cv = await prisma.cvFile.findUnique({ where: { userId } });
  if (!cv) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return new NextResponse(Buffer.from(cv.data), {
    headers: {
      'Content-Type': cv.contentType,
      'Content-Disposition': `inline; filename="${cv.filename.replace(/"/g, '')}"`,
      'Content-Length': String(cv.size),
    },
  });
}

// DELETE — remove a user's CV.
export async function DELETE(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await params;
  if (!(await canAccessCv(session.user, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.cvFile.deleteMany({ where: { userId } });
  await prisma.user.update({ where: { id: userId }, data: { cvUrl: null } });
  return NextResponse.json({ ok: true });
}
