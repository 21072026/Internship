import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessUserDocs, DOCUMENT_TYPES, ALLOWED_DOC_MIME, MAX_DOC_BYTES } from '@/lib/documentAccess';
import { contentMatchesType, CONTENT_MISMATCH_ERROR } from '@/lib/fileType';
import { logActivity } from '@/lib/activity';
import type { DocumentType } from '@prisma/client';
import { applicableRequirementsForUser } from '@/lib/documentRequirements';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId, sameTenant } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { orgIdsOfUsers, userInCallerOrg } from '@/lib/ownerOrg';

const META_SELECT = {
  id: true, ownerId: true, uploaderId: true, type: true, title: true,
  filename: true, contentType: true, size: true, version: true, isTemplate: true, createdAt: true,
  requirementId: true,
} as const;

const uploadSchema = z.object({
  type: z.enum(DOCUMENT_TYPES).default('OTHER'),
  title: z.string().trim().max(TEXT_LIMITS.documentTitle).optional(),
  targetUserId: z.string().min(1).optional(),
  isTemplate: z.boolean().optional(),
  requirementId: z.string().min(1).optional(),
});

// Document carries no orgId (#2542): an owned document belongs to its owner's
// org, a template (no owner) to its uploader's. Both are resolved through
// src/lib/ownerOrg.ts and compared with the caller's org; a foreign row reads as
// absent (list) or 404 (one row). Org-less on either side keeps today's
// behaviour.

// GET ?userId= — a user's documents (access-controlled).
// GET ?templates=1 — admin-managed template documents (any signed-in user of the
// uploader's org).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const callerOrgId = resolveOrgId(session);
  const url = new URL(request.url);
  if (url.searchParams.get('templates')) {
    const templates = await prisma.document.findMany({
      where: { isTemplate: true },
      select: META_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    // Uploader has no @relation, so the parent's org cannot be a `where`; the
    // template set is small, so it is filtered after one batched lookup.
    const uploaderOrgs = await orgIdsOfUsers(templates.map((d) => d.uploaderId));
    const dflt = await defaultOrgId();
    const documents = templates.filter((d) => sameTenant(uploaderOrgs.get(d.uploaderId), callerOrgId, dflt));
    return NextResponse.json({ documents });
  }

  const userId = url.searchParams.get('userId') || session.user.id;
  if (!(await userInCallerOrg(userId, callerOrgId))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!(await canAccessUserDocs(session.user, userId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const [documents, requirements] = await Promise.all([
    prisma.document.findMany({
      where: { ownerId: userId },
      select: META_SELECT,
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
    }),
    applicableRequirementsForUser(userId, 'en'),
  ]);
  return NextResponse.json({ documents, requirements });
  });
}

// POST (multipart) — upload a document. Fields: file, title?, type?, targetUserId?, isTemplate?
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
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
    requirementId: (form.get('requirementId') as string) || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { type, title, isTemplate, requirementId } = parsed.data;

  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  if (!ALLOWED_DOC_MIME.has(file.type)) return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });
  if (file.size > MAX_DOC_BYTES) return NextResponse.json({ error: 'File too large (max 10 MB)' }, { status: 400 });

  // Templates are admin-only and have no owner.
  if (isTemplate) {
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const ownerId = isTemplate ? null : parsed.data.targetUserId || session.user.id;
  if (ownerId && !(await userInCallerOrg(ownerId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (ownerId && !(await canAccessUserDocs(session.user, ownerId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (isTemplate && requirementId) return NextResponse.json({ error: 'Templates cannot satisfy a document requirement' }, { status: 400 });
  if (ownerId && requirementId) {
    const applicable = await applicableRequirementsForUser(ownerId, 'en');
    if (!applicable.some((requirement) => requirement.id === requirementId)) {
      return NextResponse.json({ error: 'Document requirement is not applicable to this user' }, { status: 400 });
    }
  }

  // Versioning: next version for this (owner, type).
  const prior = ownerId
    ? await prisma.document.findFirst({
        where: requirementId ? { ownerId, requirementId } : { ownerId, type: type as DocumentType },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
    : null;

  const data = Buffer.from(await file.arrayBuffer());
  // The declared MIME comes from the client; verify the bytes agree (#888).
  if (!contentMatchesType(data, file.type)) {
    return NextResponse.json({ error: CONTENT_MISMATCH_ERROR }, { status: 400 });
  }
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
      requirementId: requirementId ?? null,
      data,
    },
    select: META_SELECT,
  });
  await logActivity({ action: 'document.upload', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'document', targetId: doc.id });
  return NextResponse.json({ document: doc }, { status: 201 });
  });
}
