import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/apiKey';
import { apiError, apiNotFound, apiOk } from '@/lib/api/v1';
import { apiWrite, writeOk } from '@/lib/api/v1Write';
import { Prisma } from '@prisma/client';
import { addPrLink, parseIssueLink, readPrLinks } from '@/lib/supportReportPrLinks';
import { STATUS_NOTE_MAX } from '@/lib/supportReportIntegrationRule';
import { notifyEvent } from '@/lib/notifications/router';
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
//   * status — NEW, TRIAGED, IN_PROGRESS, WONT_FIX or RESOLVED. RESOLVED
//     (#3972, the maintainer's decision) only with the evidence on the report
//     after this write: at least one PR link AND a reporter note — otherwise
//     422 `resolve_needs_pr_and_note`. The review writes it only once the PR is
//     merged and live (.claude/skills/feedback-review/SKILL.md).
//   * issueUrl — `https://github.com/<this repo>/issues/<n>` (stored in that
//     form), or null to take it off. Another repository is 422 `validation_failed`
//     with `errors[0].code` = `wrong_repo` (`invalid_issue_url` for anything else).
//   * prUrl (#3972) — a PR of this repository the report is being worked in,
//     added to `prLinks` (the same rule as the admin's card, #3928: the same PR
//     twice is a no-op, at most SUPPORT_PR_LINK_MAX). 422 `invalid_pr_url`,
//     `wrong_repo` or `too_many`. Removing one stays the admin's.
//   * reporterNote (#3972) — the short answer the reporter reads in their own
//     list (/account/feedback, #3877), or null to take it off.
// The reporter is not MAILED from here — a mail stays the admin's decision on
// the report page. The one signal is the in-app bell when the report becomes
// RESOLVED, the same bell an admin's status change rings (#3878); every other
// change — a note, a PR, another status — is only there when they look. Another organisation's report is a 404. Every change
// writes one AuditLog row (old → new), and the row is guarded on the version
// read, so an admin editing the same report meanwhile is a 409, never lost.
const TRIAGE_STATUSES = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WONT_FIX', 'RESOLVED'] as const;
const triageSchema = z
  .object({
    status: z.enum(TRIAGE_STATUSES).optional(),
    issueUrl: z.string().max(300).nullable().optional(),
    prUrl: z.string().max(300).optional(),
    reporterNote: z.string().trim().min(1).max(STATUS_NOTE_MAX).nullable().optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.issueUrl !== undefined || b.prUrl !== undefined || b.reporterNote !== undefined, {
    message: 'send status, issueUrl, prUrl or reporterNote',
  });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withApiKey(request, 'support:triage', (key) =>
    apiWrite(request, key, triageSchema, async (body) => {
      const before = await prisma.supportReport.findFirst({
        where: { AND: [{ id }, supportReportOrgWhere(key.orgId)] },
        select: { status: true, reviewIssueUrl: true, prLinks: true, reporterNote: true, updatedAt: true, userId: true },
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
      let addedPr: number | null = null;
      let prLinks: Prisma.InputJsonValue | undefined;
      if (body.prUrl !== undefined) {
        const change = addPrLink(before.prLinks, body.prUrl, `api_key:${key.id}`, new Date());
        if (!change.ok) {
          return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
            errors: [{ path: 'prUrl', code: change.error, message: 'only a pull request of this repository: https://github.com/<repo>/pull/<n>' }],
          });
        }
        if (change.changed) {
          prLinks = change.links as unknown as Prisma.InputJsonValue;
          addedPr = change.links.at(-1)?.number ?? null;
        }
      }
      const noteChanged = body.reporterNote !== undefined && body.reporterNote !== before.reporterNote;
      // RESOLVED needs its evidence on the report as it will be after this write.
      if (body.status === 'RESOLVED') {
        const prsAfter = prLinks !== undefined ? (prLinks as unknown[]).length : readPrLinks(before.prLinks).length;
        const noteAfter = body.reporterNote !== undefined ? body.reporterNote : before.reporterNote;
        if (prsAfter === 0 || !noteAfter) {
          return apiError(422, 'validation_failed', 'The request body is invalid', undefined, {
            errors: [{ path: 'status', code: 'resolve_needs_pr_and_note', message: 'RESOLVED needs at least one PR link and a reporter note on the report' }],
          });
        }
      }
      const data = {
        ...(body.status !== undefined && body.status !== before.status ? { status: body.status } : {}),
        ...(issueUrl !== undefined && issueUrl !== before.reviewIssueUrl ? { reviewIssueUrl: issueUrl } : {}),
        ...(prLinks !== undefined ? { prLinks } : {}),
        ...(noteChanged ? { reporterNote: body.reporterNote ?? null, reporterNoteAt: body.reporterNote ? new Date() : null } : {}),
      };
      if (Object.keys(data).length > 0) {
        const written = await prisma.$transaction(async (tx) => {
          // Guarded on the version read: an admin's edit in between wins and this is a 409.
          const { count } = await tx.supportReport.updateMany({
            where: { AND: [{ id }, supportReportOrgWhere(key.orgId), { updatedAt: before.updatedAt }] },
            data,
          });
          if (count === 0) return false;
          await tx.auditLog.create({
            data: {
              orgId: key.orgId,
              actorId: `api_key:${key.id}`,
              action: 'API_SUPPORT_REPORT_TRIAGE',
              targetId: id,
              detail: JSON.stringify({
                apiKeyId: key.id,
                ...('status' in data ? { status: [before.status, data.status] } : {}),
                ...('reviewIssueUrl' in data ? { issueUrl: [before.reviewIssueUrl, data.reviewIssueUrl] } : {}),
                ...(addedPr !== null ? { prAdded: addedPr } : {}),
                // The note's text is the reporter's answer, not audit material: only that it changed.
                ...(noteChanged ? { reporterNote: body.reporterNote ? 'set' : 'cleared' } : {}),
              }),
            },
          });
          return true;
        });
        if (!written) return apiError(409, 'conflict', 'The report changed meanwhile; read it again and retry');
        // Done: the reporter's bell (in-app only, so no consent to contact is needed).
        if ('status' in data && data.status === 'RESOLVED') {
          await notifyEvent(before.userId, 'support_report.updated', { reportId: id }, { channels: ['inApp'], orgId: key.orgId });
        }
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
