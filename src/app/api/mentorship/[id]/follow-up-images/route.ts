import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { FOLLOW_UP_IMAGE_BYTES, FOLLOW_UP_IMAGE_DRAFT_MAX, checkUpload } from '@/lib/followUpImageRule';
import { FOLLOW_UP_IMAGE_META, followUpImageAccess, sweepStaleDrafts } from '@/lib/followUpImages';

// A record's follow-up images (#3931). POST uploads one image as a DRAFT — it
// reaches the follow-up only when a follow-up write names it (PUT
// /api/mentorship/[id] `nextActionImageIds`, the hand-off's `imageIds`). GET
// lists them: the ones on the follow-up now, and the history (cleared ones).
// Who may: src/lib/followUpImages.ts. A record the caller may not read is 404.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const access = await followUpImageAccess(session, id);
    if (!access?.read) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const rows = await prisma.followUpImage.findMany({
      where: { relationId: id, attachedAt: { not: null } },
      orderBy: { attachedAt: 'asc' },
      select: FOLLOW_UP_IMAGE_META,
    });
    return NextResponse.json({
      current: rows.filter((r) => !r.clearedAt),
      history: rows.filter((r) => r.clearedAt),
    });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = enforceRateLimit(request, 'follow-up-image-upload', { limit: 30, windowMs: 60 * 1000 });
  if (limited) return limited;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(session, async () => {
    const access = await followUpImageAccess(session, id);
    if (!access?.read) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!access.write) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Multipart is not judged by the JSON body limit (bodyLimitRule.ts): refuse a
    // body that cannot hold one allowed image before reading it into memory.
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > FOLLOW_UP_IMAGE_BYTES + 64 * 1024) return NextResponse.json({ error: 'Not accepted', code: 'too_large' }, { status: 413 });
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') return NextResponse.json({ error: 'Send one image as `file`', code: 'no_file' }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkUpload(bytes);
    if (!check.ok) return NextResponse.json({ error: 'Not accepted', code: check.error }, { status: check.error === 'too_large' ? 413 : 400 });

    await sweepStaleDrafts(session.user.id);
    const drafts = await prisma.followUpImage.count({ where: { relationId: id, uploaderId: session.user.id, attachedAt: null } });
    if (drafts >= FOLLOW_UP_IMAGE_DRAFT_MAX) return NextResponse.json({ error: 'Too many unattached images', code: 'too_many_drafts' }, { status: 429 });

    const image = await prisma.followUpImage.create({
      data: { relationId: id, uploaderId: session.user.id, contentType: check.type, size: bytes.length, data: Buffer.from(bytes) },
      select: FOLLOW_UP_IMAGE_META,
    });
    return NextResponse.json({ image }, { status: 201 });
  });
}
