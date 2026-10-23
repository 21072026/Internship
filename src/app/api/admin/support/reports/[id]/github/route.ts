import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { withTenantScope } from '@/lib/orgContext';
import { reportAdminOrg } from '@/lib/supportReportAccess';
import { sanitizeFeedbackContext } from '@/lib/feedbackContext';
import {
  ISSUE_BODY_MAX,
  ISSUE_TITLE_MAX,
  buildIssueDraft,
  githubConfig,
  isIssueUrlOf,
} from '@/lib/supportReportIntegrationRule';

// "Create GitHub issue" for one bug report (#3132).
//   GET  — the default draft (public-safe by construction, see
//          supportReportIntegrationRule.ts), the target repository and whether
//          it is private, so the admin reads exactly what will be published.
//   POST — creates the issue from the title/body the admin confirmed and
//          stores its URL. One issue per report: a conditional claim
//          (`githubIssueUrl: null` → 'pending:…') admits one caller.
// The token is a server secret (SUPPORT_GITHUB_TOKEN) and never leaves here.

const PENDING = 'pending:';
// SUPPORT_GITHUB_API_BASE replaces the API host only together with the e2e
// stub's switch, which no deployment sets (the HIBP / Klaviyo stub pattern).
const API =
  process.env.SUPPORT_GITHUB_ALLOW_INSECURE_STUB === '1' && process.env.SUPPORT_GITHUB_API_BASE
    ? process.env.SUPPORT_GITHUB_API_BASE
    : 'https://api.github.com';

const postSchema = z.object({
  title: z.string().trim().min(1).max(ISSUE_TITLE_MAX),
  body: z.string().max(ISSUE_BODY_MAX),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return { session, orgId: await reportAdminOrg(session) };
}

function gh(token: string, path: string, init?: RequestInit) {
  return fetch(`${API}${path}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'interncrm-support-reports',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

async function loadReport(id: string, orgId: string) {
  return prisma.supportReport.findFirst({
    where: { id, orgId },
    select: {
      id: true, type: true, url: true, appVersion: true, env: true, viewport: true, userAgent: true,
      createdAt: true, context: true, githubIssueUrl: true,
      files: { select: { kind: true } },
    },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  return withTenantScope(admin.session, async () => {
    const report = await loadReport(id, admin.orgId);
    if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const config = githubConfig(process.env);
    if (!config) return NextResponse.json({ configured: false, issueUrl: report.githubIssueUrl });
    const ctx = sanitizeFeedbackContext(report.context);
    const draft = buildIssueDraft({
      ...report,
      hasScreenshot: report.files.some((f) => f.kind === 'SCREENSHOT'),
      hasReplay: report.files.some((f) => f.kind === 'REPLAY'),
      consoleCount: ctx.consoleErrors.length,
      failedRequests: ctx.failedRequests,
    });
    // Unknown visibility reads as public: the warning is the safe default.
    let isPrivate = false;
    try {
      const res = await gh(config.token, `/repos/${config.repo}`);
      if (res.ok) isPrivate = (await res.json()).private === true;
    } catch {
      // keep the warning
    }
    return NextResponse.json({ configured: true, repo: config.repo, isPrivate, issueUrl: report.githubIssueUrl, draft });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const config = githubConfig(process.env);
  if (!config) return NextResponse.json({ error: 'GitHub is not configured', code: 'not_configured' }, { status: 409 });
  const { id } = await params;

  return withTenantScope(admin.session, async () => {
    const claim = await prisma.supportReport.updateMany({
      where: { id, orgId: admin.orgId, githubIssueUrl: null },
      data: { githubIssueUrl: `${PENDING}${Date.now()}` },
    });
    if (claim.count === 0) {
      const exists = await prisma.supportReport.count({ where: { id, orgId: admin.orgId } });
      return exists
        ? NextResponse.json({ error: 'An issue already exists for this report', code: 'already_linked' }, { status: 409 })
        : NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    try {
      const res = await gh(config.token, `/repos/${config.repo}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: parsed.data.title, body: parsed.data.body }),
      });
      const issueUrl = res.ok ? String((await res.json()).html_url ?? '') : '';
      if (!isIssueUrlOf(config.repo, issueUrl)) throw new Error(`github ${res.status}`);
      await prisma.supportReport.update({ where: { id }, data: { githubIssueUrl: issueUrl } });
      return NextResponse.json({ issueUrl }, { status: 201 });
    } catch (e) {
      // Release the claim so the admin can try again.
      await prisma.supportReport.updateMany({ where: { id, githubIssueUrl: { startsWith: PENDING } }, data: { githubIssueUrl: null } });
      logger.warning('support_report.github_failed', { reportId: id, error: e instanceof Error ? e.message : String(e) });
      return NextResponse.json({ error: 'The issue could not be created', code: 'github_failed' }, { status: 502 });
    }
  });
}
