import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { getOrgBranding } from '@/lib/orgBranding';
import { canIssueCertificate } from '@/lib/certificateEligibility';
import { certificateTitle } from '@/lib/certificateTemplates';
import { generateCertificatePdf } from '@/lib/certificatePdf';
import { logActivity } from '@/lib/activity';
import type { DocumentType } from '@prisma/client';

// Kept in sync with the single-page layout budget in certificatePdf.ts — long
// enough for a certificate paragraph or a short reference letter, short
// enough to stay on one A4 landscape page (no pagination is implemented).
const BODY_MAX = 4000;

const genSchema = z.object({
  variant: z.enum(['CERTIFICATE', 'REFERENCE_LETTER']),
  locale: z.enum(['en', 'tr', 'de']),
  body: z.string().trim().min(1).max(BODY_MAX),
  signatureName: z.string().trim().max(120).optional(),
  signatureTitle: z.string().trim().max(120).optional(),
});

const COMBINING_DIACRITICS = new RegExp('[̀-ͯ]', 'g');

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'certificate';
}

const META_SELECT = {
  id: true, ownerId: true, uploaderId: true, type: true, title: true,
  filename: true, contentType: true, size: true, version: true, isTemplate: true, createdAt: true,
} as const;

// POST — generate an org-branded PDF (certificate or reference letter) for a
// completed internship and store it as the mentee's CERTIFICATE Document
// (#813). Admin, or the relation's mentor, only — the mentee cannot generate
// their own.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  return withTenantScope(session, async () => {
    const relation = await prisma.mentorshipRelation.findUnique({
      where: { id },
      include: {
        mentor: { select: { id: true, fullName: true } },
        mentee: { select: { id: true, fullName: true } },
      },
    });
    if (!relation) return NextResponse.json({ error: 'Relation not found' }, { status: 404 });

    const isAuthorized = session.user.role === 'ADMIN' || relation.mentorId === session.user.id;
    if (!isAuthorized) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const json = await request.json().catch(() => null);
    const parsed = genSchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { variant, locale, body, signatureName, signatureTitle } = parsed.data;

    const stages = await resolvePipelineStages(session.user.orgId, locale);
    if (!canIssueCertificate(relation, stages)) {
      return NextResponse.json({ error: 'Internship is not completed yet' }, { status: 400 });
    }

    const branding = await getOrgBranding(session.user.orgId);
    const title = certificateTitle(variant, locale);
    const pdfBytes = await generateCertificatePdf({
      title,
      bodyMarkdown: body,
      branding,
      signatureName: signatureName || relation.mentor.fullName,
      signatureTitle: signatureTitle || '',
      generatedAt: new Date(),
    });

    const prior = await prisma.document.findFirst({
      where: { ownerId: relation.menteeId, type: 'CERTIFICATE' as DocumentType },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const docTitle = `${title} — ${relation.mentee.fullName}`;
    const doc = await prisma.document.create({
      data: {
        ownerId: relation.menteeId,
        uploaderId: session.user.id,
        type: 'CERTIFICATE',
        title: docTitle,
        filename: `${slugify(docTitle)}.pdf`,
        contentType: 'application/pdf',
        size: pdfBytes.length,
        version: (prior?.version ?? 0) + 1,
        data: pdfBytes,
      },
      select: META_SELECT,
    });

    await logActivity({
      action: 'document.certificate_generate',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'document',
      targetId: doc.id,
      detail: docTitle,
    });

    return NextResponse.json({ document: doc }, { status: 201 });
  });
}
