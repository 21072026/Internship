import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// POST (multipart) — upload/replace own avatar (admin may set anyone's via targetUserId).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const form = await request.formData();
  const file = form.get('file');
  const targetUserId = (form.get('targetUserId') as string) || session.user.id;

  if (targetUserId !== session.user.id && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: 'Only PNG, JPEG, WebP or GIF images are allowed' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'Image too large (max 2 MB)' }, { status: 400 });
  }

  const data = Buffer.from(await file.arrayBuffer());
  await prisma.avatarFile.upsert({
    where: { userId: targetUserId },
    create: { userId: targetUserId, contentType: file.type, size: file.size, data },
    update: { contentType: file.type, size: file.size, data },
  });
  await prisma.user.update({ where: { id: targetUserId }, data: { avatarUrl: `/api/avatar/${targetUserId}` } });

  return NextResponse.json({ ok: true, avatarUrl: `/api/avatar/${targetUserId}` });
}
