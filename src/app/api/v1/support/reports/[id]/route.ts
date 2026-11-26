import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiError, apiNotFound, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { parseIssueLink } from '@/lib/supportReportPrLinks';
import { auditSupportRead, serializeSupportReport, supportReportOrgWhere, supportReportSelect } from '@/lib/api/v1Support';

// GET /api/v1/support/reports/{id} — the same object as one element of the
// list (`support:read`). Another organisation's id is a 404, exactly like a
// missing one; a read that finds the report is audited (key + report id).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'support:read', async (key) => {
    const row = await prisma.supportReport.findFirst({
      where: { AND: [{ id }, supportReportOrgWhere(key.orgId)] },
      select: supportReportSelect,
    });
    if (!row) return apiNotFound();
    await auditSupportRead(key, 'API_SUPPORT_REPORT_READ', [row.id]);
    return apiOk(serializeSupportReport(row));
  });
}

// PATCH /api/v1/support/reports/{id} — the feedback review's one write (#3937,
// scope `support:triage`): the report's status and the issue it opened in this
// repository. Nothing else is accepted (`.strict()`: 422 on any other key).
//   * status — NEW, TRIAGED, IN_PROGRESS or WONT_FIX. Never RESOLVED: "done"
//     is the admin's word, after the PR (#3928) is in.
//   * issueUrl — `https://github.com/<this repo>/issues/<n>` (stored in that
//     form), or null to take it off. Another repository is 422 `validation_failed`
//     with `errors[0].code` = `wrong_repo` (`invalid_issue_url` for anything else).
// The reporter is not told anything from here: no mail, no bell — telling
// them stays the admin's decision on the report page. Another organisation's
// report is a 404. Every change writes one AuditLog row (old → new).
const TRIAGE_STATUSES = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WONT_FIX'] as const;
const triageSchema = z
  .object({
    status: z.enum(TRIAGE_STATUSES).optional(),
    issueUrl: z.string().max(300).nullable().optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.issueUrl !== undefined, { message: 'send status, issueUrl or both' });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'support:triage', (key) =>
    apiWrite(request, key, triageSchema, async (body) => {
      const before = await prisma.supportReport.findFirst({
        where: { AND: [{ id }, supportReportOrgWhere(key.orgId)] },
        select: { status: true, reviewIssueUrl: true },
      });
      if (!before) return apiNotFound();
      let issueUrl: string | null | undefined;
      if (body.issueUrl === null) issueUrl = null;
      else if (body.issueUrl !== undefined) {
        const parsed = parseIssueLink(body.issueUrl);
        if (!parsed.ok) {
          return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
            errors: [{ path: 'issueUrl', code: parsed.error, message: 'only an issue of this repository: https://github.com/<repo>/issues/<n>' }],
          });
        }
        issueUrl = parsed.url;
      }
      const data = {
        ...(body.status !== undefined && body.status !== before.status ? { status: body.status } : {}),
        ...(issueUrl !== undefined && issueUrl !== before.reviewIssueUrl ? { reviewIssueUrl: issueUrl } : {}),
      };
      if (Object.keys(data).length > 0) {
        await prisma.$transaction([
          prisma.supportReport.updateMany({ where: { AND: [{ id }, supportReportOrgWhere(key.orgId)] }, data }),
          prisma.auditLog.create({
            data: {
              orgId: key.orgId,
              actorId: `api_key:${key.id}`,
              action: 'API_SUPPORT_REPORT_TRIAGE',
              targetId: id,
              detail: JSON.stringify({
                apiKeyId: key.id,
                ...('status' in data ? { status: [before.status, data.status] } : {}),
                ...('reviewIssueUrl' in data ? { issueUrl: [before.reviewIssueUrl, data.reviewIssueUrl] } : {}),
              }),
            },
          }),
        ]);
      }
      const row = await prisma.supportReport.findFirst({ where: { AND: [{ id }, supportReportOrgWhere(key.orgId)] }, select: supportReportSelect });
      return writeOk(apiOk(serializeSupportReport(row!)), {
        action: 'api.support_report.triage',
        targetType: 'supportReport',
        targetId: id,
        detail: Object.keys(data).length ? `changed ${Object.keys(data).join(', ')}` : 'no change',
      });
    }),
  );
}
