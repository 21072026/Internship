// The /api/v1 shape of an in-app bug report (SupportReport, #3130) and the
// audit row every read of one writes. Server-only.
//
// What leaves: the report's id, type, status, rating, times, the reporter's
// name and role (enough to triage; never their e-mail), the page it was sent
// from, the build that answered, the description, the request ids and the
// console / failed-request context. Every free-text and URL field goes through
// the ONE masking path, src/lib/feedbackContext.ts (maskUrl, maskText,
// sanitizeFeedbackContext) — again on the way out, because the rules may have
// grown since the row was written. No second masking path lives here.
//
// What never leaves: the reporter's e-mail and user agent, the screenshot
// bytes (GET …/screenshot, a separate scope), the replay, attachments.
//
// Real people's text: nothing here logs a description or a context. The audit
// row names the key, the action and the report ids — ids only.
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  FEEDBACK_DESCRIPTION_MAX,
  maskText,
  maskUrl,
  sanitizeFeedbackContext,
} from '@/lib/feedbackContext';

/** At most this many reports per page — lower than the v1 default on purpose. */
export const SUPPORT_REPORT_PAGE_MAX = 50;

export const supportReportSelect = {
  id: true,
  type: true,
  status: true,
  rating: true,
  description: true,
  url: true,
  appVersion: true,
  env: true,
  context: true,
  contactAllowed: true,
  githubIssueUrl: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { fullName: true, role: true } },
  files: { where: { kind: 'SCREENSHOT' as const }, select: { id: true } },
} satisfies Prisma.SupportReportSelect;

type SupportReportRow = Prisma.SupportReportGetPayload<{ select: typeof supportReportSelect }>;

/** A report of the key's organisation: the one org conjunct every read uses. */
export function supportReportOrgWhere(orgId: string): Prisma.SupportReportWhereInput {
  return { orgId };
}

export function serializeSupportReport(r: SupportReportRow) {
  const context = sanitizeFeedbackContext(r.context);
  const requestIds = Array.from(
    new Set(context.failedRequests.map((f) => f.requestId).filter((id): id is string => !!id)),
  );
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    rating: r.rating,
    reporter: { name: r.user.fullName, role: r.user.role },
    page: maskUrl(r.url),
    appVersion: r.appVersion,
    env: r.env,
    description: maskText(r.description, FEEDBACK_DESCRIPTION_MAX),
    requestIds,
    consoleErrors: context.consoleErrors,
    failedRequests: context.failedRequests,
    contactAllowed: r.contactAllowed,
    githubIssueUrl: r.githubIssueUrl,
    hasScreenshot: r.files.length > 0,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export type SupportReadAction = 'API_SUPPORT_REPORT_LIST' | 'API_SUPPORT_REPORT_READ' | 'API_SUPPORT_REPORT_SCREENSHOT';

/**
 * One AuditLog row per read: which key, which action, which reports (ids
 * only). The actor is the key (`api_key:<id>`) — an API request has no user.
 * Written with the key's orgId explicitly, so the org's audit drain carries it.
 */
export async function auditSupportRead(
  key: { id: string; orgId: string },
  action: SupportReadAction,
  reportIds: string[],
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      orgId: key.orgId,
      actorId: `api_key:${key.id}`,
      action,
      targetId: reportIds.length === 1 ? reportIds[0] : null,
      detail: JSON.stringify({ apiKeyId: key.id, reportIds }),
    },
  });
}
