import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { STATUS_NOTE_MAX } from '@/lib/supportReportIntegrationRule';
import { sendSupportReportUpdateEmail } from '@/services/emailService';
import { withTenantScope } from '@/lib/orgContext';
import { reportAdminOrg, SUPPORT_REPORT_STATUSES } from '@/lib/supportReportAccess';

// One bug report (#3130): GET the full record (context + file metadata, never
// bytes), PATCH its status. Another org's id is 404, like a missing one.

const patchSchema = z.object({
  status: z.enum(SUPPORT_REPORT_STATUSES),
  // #3132: tell the reporter — honoured only when they allowed contact.
  notifyReporter: z.boolean().optional().default(false),
  note: z.string().trim().max(STATUS_NOTE_MAX).optional(),
});

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('support.read', { request: _request });
  if ('error' in gate) return gate.error;
  const admin = { session: gate.session, orgId: await reportAdminOrg(gate.session) };
  const { id } = await params;
  return withTenantScope(admin.session, async () => {
    const report = await prisma.supportReport.findFirst({
      where: { id, orgId: admin.orgId },
      include: {
        user: { select: { id: true, fullName: true, email: true, role: true } },
        files: { select: { id: true, kind: true, filename: true, contentType: true, size: true } },
      },
    });
    if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ report });
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('support.write', { request });
  if ('error' in gate) return gate.error;
  const admin = { session: gate.session, orgId: await reportAdminOrg(gate.session) };
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { id } = await params;
  return withTenantScope(admin.session, async () => {
    const { count } = await prisma.supportReport.updateMany({
      where: { id, orgId: admin.orgId },
      data: { status: parsed.data.status },
    });
    if (count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    let notified = false;
    if (parsed.data.notifyReporter) {
      const report = await prisma.supportReport.findFirst({
        where: { id, orgId: admin.orgId },
        select: { contactAllowed: true, orgId: true, user: { select: { id: true, email: true, preferredLanguage: true, isActive: true } } },
      });
      if (!report?.contactAllowed) {
        return NextResponse.json({ error: 'The reporter did not allow contact', code: 'contact_not_allowed' }, { status: 409 });
      }
      if (report.user.isActive) {
        try {
          const sent = await sendSupportReportUpdateEmail({
            to: report.user.email,
            userId: report.user.id,
            locale: report.user.preferredLanguage,
            orgId: report.orgId,
            status: parsed.data.status,
            note: parsed.data.note || null,
          });
          notified = sent !== 'SKIPPED';
        } catch (e) {
          logger.warning('support_report.update_mail_failed', { reportId: id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return NextResponse.json({ ok: true, status: parsed.data.status, notified });
  });
}
