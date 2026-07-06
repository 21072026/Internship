import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessUserDocs, DOCUMENT_TYPES, ALLOWED_DOC_MIME, MAX_DOC_BYTES } from '@/lib/documentAccess';
import { logActivity } from '@/lib/activity';
import type { DocumentType } from '@prisma/client';

const META_SELECT = {
  id: true, ownerId: true, uploaderId: true, type: true, title: true,
  filename: true, contentType: true, size: true, version: true, isTemplate: true, createdAt: true,
} as const;

const uploadSchema = z.object({
  type: z.enum(DOCUMENT_TYPES).default('OTHER'),
  title: z.string().trim().max(200).optional(),
  targetUserId: z.string().min(1).optional(),
  isTemplate: z.boolean().optional(),
});

// GET ?userId= — a user's documents (access-controlled).
// GET ?templates=1 — admin-managed template documents (any signed-in user).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  if (url.searchParams.get('templates')) {
    const documents = await prisma.document.findMany({
      where: { isTemplate: true },
      select: META_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ documents });
  }

  const userId = url.searchParams.get('userId') || session.user.id;
  if (!(await canAccessUserDocs(session.user, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const documents = await prisma.document.findMany({
    where: { ownerId: userId },
    select: META_SELECT,
    orderBy: [{ type: 'asc' }, { version: 'desc' }],
  });
  return NextResponse.json({ documents });
}

// POST (multipart) — upload a document. Fields: file, title?, type?, targetUserId?, isTemplate?
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }
  const file = form.get('file');

  const parsed = uploadSchema.safeParse({
    type: ((form.get('type') as string) || 'OTHER').toUpperCase(),
    title: ((form.get('title') as string) || '').trim() || undefined,
    targetUserId: (form.get('targetUserId') as string) || undefined,
    isTemplate: form.get('isTemplate') === 'true',
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { type, title, isTemplate } = parsed.data;

  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  if (!ALLOWED_DOC_MIME.has(file.type)) return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });
  if (file.size > MAX_DOC_BYTES) return NextResponse.json({ error: 'File too large (max 10 MB)' }, { status: 400 });

  // Templates are admin-only and have no owner.
  if (isTemplate) {
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const ownerId = isTemplate ? null : parsed.data.targetUserId || session.user.id;
  if (ownerId && !(await canAccessUserDocs(session.user, ownerId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Versioning: next version for this (owner, type).
  const prior = ownerId
    ? await prisma.document.findFirst({
        where: { ownerId, type: type as DocumentType },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
    : null;

  const data = Buffer.from(await file.arrayBuffer());
  const doc = await prisma.document.create({
    data: {
      ownerId,
      uploaderId: session.user.id,
      type: type as DocumentType,
      title: title || file.name,
      filename: file.name,
      contentType: file.type,
      size: file.size,
      version: (prior?.version ?? 0) + 1,
      isTemplate,
      data,
    },
    select: META_SELECT,
  });
  await logActivity({ action: 'document.upload', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'document', targetId: doc.id });
  return NextResponse.json({ document: doc }, { status: 201 });
}
