import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withRequestScope } from '@/lib/requestContext';
import { APP_VERSION, GIT_SHA } from '@/lib/version';
import { APP_ENV } from '@/lib/appEnv';
import { buildSupportAttachments } from '@/lib/supportMessageRequest';
import { SUPPORT_ATTACHMENT_MAX_COUNT } from '@/lib/supportAttachments';
import {
  FEEDBACK_CONTEXT_MAX_BYTES,
  FEEDBACK_DESCRIPTION_MAX,
  maskUrl,
  sanitizeFeedbackContext,
} from '@/lib/feedbackContext';

// In-app bug / feedback report (#3130). Any signed-in role may send one; the
// row lands in the reporter's own org and is read only through
// /api/admin/support/reports. The browser's context is re-sanitized here
// (feedbackContext.ts) — the client masked it already, but a body is never
// trusted — and version/env/user agent are stamped by the server.

const schema = z.object({
  type: z.enum(['BUG', 'FEEDBACK']),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  description: z.string().trim().min(1).max(FEEDBACK_DESCRIPTION_MAX),
  contactAllowed: z.enum(['true', 'false']),
  url: z.string().max(4096).optional().default(''),
  viewport: z.string().regex(/^\d{1,5}x\d{1,5}$/).optional().default(''),
  context: z.string().max(FEEDBACK_CONTEXT_MAX_BYTES).optional().default('{}'),
});

export async function POST(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Per person, not per IP: a report may carry 10 MB of images.
    const limited = enforceRateLimit(request, 'support-report', { limit: 5, windowMs: 15 * 60 * 1000, subject: session.user.id });
    if (limited) return limited;

    return withTenantScope(session, async () => {
      if (!request.headers.get('content-type')?.includes('multipart/form-data')) {
        return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 415 });
      }
      const form = await request.formData().catch(() => null);
      if (!form) return NextResponse.json({ error: 'Invalid multipart request' }, { status: 400 });

      const fields: Record<string, string> = {};
      const screenshots: File[] = [];
      const files: File[] = [];
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') fields[key] = value;
        else if (key === 'screenshot') screenshots.push(value);
        else if (key === 'files') files.push(value);
      }
      const parsed = schema.safeParse(fields);
      if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
      if (screenshots.length > 1) return NextResponse.json({ error: 'One screenshot at most' }, { status: 400 });
      if (screenshots.length + files.length > SUPPORT_ATTACHMENT_MAX_COUNT) {
        return NextResponse.json({ error: `Too many attachments (max ${SUPPORT_ATTACHMENT_MAX_COUNT})` }, { status: 400 });
      }
      // Same type / size / magic-byte rules as every support upload.
      const shot = await buildSupportAttachments(screenshots);
      if (!shot.ok) return NextResponse.json({ error: shot.error }, { status: shot.status });
      if (shot.attachments.some((a) => !a.contentType.startsWith('image/'))) {
        return NextResponse.json({ error: 'Screenshot must be an image' }, { status: 400 });
      }
      const extra = await buildSupportAttachments(files);
      if (!extra.ok) return NextResponse.json({ error: extra.error }, { status: extra.status });

      let rawContext: unknown = {};
      try {
        rawContext = JSON.parse(parsed.data.context);
      } catch {
        return NextResponse.json({ error: 'Invalid context' }, { status: 400 });
      }

      const d = parsed.data;
      const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { orgId: true } });
      const orgId = me?.orgId ?? resolveOrgId(session) ?? (await defaultOrgId());

      const report = await prisma.supportReport.create({
        data: {
          orgId,
          userId: session.user.id,
          type: d.type,
          rating: d.rating ?? null,
          description: d.description,
          url: maskUrl(d.url),
          appVersion: `${APP_VERSION} (${GIT_SHA})`.slice(0, 64),
          env: APP_ENV,
          userAgent: (request.headers.get('user-agent') ?? '').slice(0, 512),
          viewport: d.viewport,
          context: sanitizeFeedbackContext(rawContext) as object,
          contactAllowed: d.contactAllowed === 'true',
          files: {
            create: [
              ...shot.attachments.map((a) => ({ ...a, kind: 'SCREENSHOT' as const })),
              ...extra.attachments.map((a) => ({ ...a, kind: 'ATTACHMENT' as const })),
            ],
          },
        },
        select: { id: true },
      });

      return NextResponse.json({ id: report.id }, { status: 201 });
    });
  });
}
