import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { canAccessCv } from '@/lib/cvAccess';
import { downloadHeaders } from '@/lib/download';

// A CV the browser can safely render on our own origin. Upload only accepts PDF
// and Word (see POST /api/cv), and the bytes are verified against the declared
// type (#888) — so a PDF here really is a PDF, and the browser's own viewer
// displays it without any of our HTML/script context. Word is not renderable by
// any browser, so it keeps downloading.
const INLINE_TYPES = new Set(['application/pdf']);

// GET — a user's CV (access-controlled). Downloads by default; `?inline=1`
// displays it in the browser when the type allows (see INLINE_TYPES).
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await params;
  if (!(await canAccessCv(session.user, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  return await withTenantScope(session, async () => {
  const cv = await prisma.cvFile.findUnique({ where: { userId } });
  if (!cv) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Rendered in place only when asked for and only for a type that cannot run
  // as a page on our own origin (#890) — everything else downloads.
  const wantsInline = new URL(request.url).searchParams.get('inline') === '1';
  const inline = wantsInline && INLINE_TYPES.has(cv.contentType);

  return new NextResponse(Buffer.from(cv.data), {
    headers: downloadHeaders({ filename: cv.filename, contentType: cv.contentType, size: cv.size, inline }),
  });
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

  return await withTenantScope(session, async () => {
  await prisma.cvFile.deleteMany({ where: { userId } });
  await prisma.user.update({ where: { id: userId }, data: { cvUrl: null } });
  return NextResponse.json({ ok: true });
  });
}
