import 'server-only';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';

// "My feedback" (#3877, docs/feedback-reports.md): the reports a person sent
// through the feedback button, read back by that person only. What leaves here
// is what they wrote and what was done with it — type, their description, the
// page path, the status and the admin's note to them. Never the screenshot, the
// replay, the console/network context, the user agent or a GitHub link: those
// are triage material (and the issue may be in a public repository).
//
// "Mine" is the session's own user id in the org a report is filed under (the
// same resolution POST /api/support/reports uses); anything else reads as
// missing — another person's id is a 404, never a 403 that confirms it.

export const MY_FEEDBACK_LIMIT = 50;

export interface MyFeedbackReport {
  id: string;
  type: 'BUG' | 'FEEDBACK';
  status: string;
  description: string;
  /** The page it was sent from, path only (no host, no query). */
  path: string;
  createdAt: string;
  updatedAt: string;
  reporterNote: string | null;
  reporterNoteAt: string | null;
}

async function ownOrgId(session: Session): Promise<string> {
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { orgId: true } });
  return me?.orgId ?? resolveOrgId(session) ?? (await defaultOrgId());
}

/** The path of a stored (already masked) page URL — never its host or query. */
export function reportPath(url: string): string {
  try {
    return new URL(url, 'https://x.invalid').pathname;
  } catch {
    return '/';
  }
}

const SELECT = {
  id: true,
  type: true,
  status: true,
  description: true,
  url: true,
  createdAt: true,
  updatedAt: true,
  reporterNote: true,
  reporterNoteAt: true,
} as const;

type Row = {
  id: string;
  type: string;
  status: string;
  description: string;
  url: string;
  createdAt: Date;
  updatedAt: Date;
  reporterNote: string | null;
  reporterNoteAt: Date | null;
};

function view(r: Row): MyFeedbackReport {
  return {
    id: r.id,
    type: r.type === 'BUG' ? 'BUG' : 'FEEDBACK',
    status: r.status,
    description: r.description,
    path: reportPath(r.url),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    reporterNote: r.reporterNote,
    reporterNoteAt: r.reporterNoteAt ? r.reporterNoteAt.toISOString() : null,
  };
}

export async function listMyFeedbackReports(session: Session): Promise<MyFeedbackReport[]> {
  const orgId = await ownOrgId(session);
  const rows = await prisma.supportReport.findMany({
    where: { userId: session.user.id, orgId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MY_FEEDBACK_LIMIT,
    select: SELECT,
  });
  return rows.map(view);
}

export async function myFeedbackReport(session: Session, id: string): Promise<MyFeedbackReport | null> {
  const orgId = await ownOrgId(session);
  const row = await prisma.supportReport.findFirst({ where: { id, userId: session.user.id, orgId }, select: SELECT });
  return row ? view(row) : null;
}
