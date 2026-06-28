import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessCv } from '@/lib/cvAccess';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// POST (multipart) — upload/replace a CV. field "file", optional "targetUserId".
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const form = await request.formData();
  const file = form.get('file');
  const targetUserId = (form.get('targetUserId') as string) || session.user.id;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (!(await canAccessCv(session.user, targetUserId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: 'Only PDF or Word documents are allowed' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large (max 5 MB)' }, { status: 400 });
  }

  const data = Buffer.from(await file.arrayBuffer());
  await prisma.cvFile.upsert({
    where: { userId: targetUserId },
    create: { userId: targetUserId, filename: file.name, contentType: file.type, size: file.size, data },
    update: { filename: file.name, contentType: file.type, size: file.size, data },
  });
  await prisma.user.update({ where: { id: targetUserId }, data: { cvUrl: `/api/cv/${targetUserId}` } });

  return NextResponse.json({ ok: true, filename: file.name });
}
