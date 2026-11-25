import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { reportAdminOrg } from '@/lib/supportReportAccess';
import { addPrLink, removePrLink } from '@/lib/supportReportPrLinks';

// The PRs a report was worked in (#3928), typed in by an admin: POST adds one,
// DELETE removes one. The rule (which URLs, how many) is
// src/lib/supportReportPrLinks.ts. ADMIN ONLY, both ways: support.write to
// change, and nothing the reporter reads ever selects the column. Another
// org's report answers 404, like a missing one. Each change is one AuditLog row.

const addSchema = z.object({ url: z.string().max(300) });
const removeSchema = z.object({ number: z.number().int().positive() });

async function change(
  request: Request,
  params: Promise<{ id: string }>,
  apply: (current: unknown, actorId: string) => { ok: false; error: string } | { ok: true; links: unknown[]; changed: boolean; number: number },
  action: string,
) {
  return withRequestScope(request, async () => {
    const gate = await requirePermission('support.write', { request });
    if ('error' in gate) return gate.error;
    const session = gate.session;
    const orgId = await reportAdminOrg(session);
    const { id } = await params;
    return withTenantScope(session, async () => {
      const report = await prisma.supportReport.findFirst({ where: { id, orgId }, select: { id: true, prLinks: true, updatedAt: true } });
      if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      const result = apply(report.prLinks, session.user.id);
      if (!result.ok) return NextResponse.json({ error: 'Invalid link', code: result.error }, { status: 400 });
      if (!result.changed) return NextResponse.json({ prLinks: result.links, unchanged: true });
      // Guarded on the row as read, so two admins editing at once cannot drop each other's link.
      const written = await prisma.$transaction(async (tx) => {
        const { count } = await tx.supportReport.updateMany({
          where: { id, orgId, updatedAt: report.updatedAt },
          // No PR left → NULL, so "has a PR" is one `prLinks` null test in the inbox filter.
          data: { prLinks: result.links.length ? (result.links as Prisma.InputJsonValue) : Prisma.DbNull },
        });
        if (count === 0) return false;
        await tx.auditLog.create({
          data: { orgId, actorId: session.user.id, action, targetId: id, detail: `#${result.number}` },
        });
        return true;
      });
      if (!written) return NextResponse.json({ error: 'The report changed; reload and try again', code: 'conflict' }, { status: 409 });
      return NextResponse.json({ prLinks: result.links });
    });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = addSchema.safeParse(await request.clone().json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const now = new Date();
  return change(
    request,
    params,
    (current, actorId) => {
      const r = addPrLink(current, parsed.data.url, actorId, now);
      return r.ok ? { ...r, number: r.links.at(-1)?.number ?? 0 } : r;
    },
    'support_report.pr_link_added',
  );
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const parsed = removeSchema.safeParse(await request.clone().json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  return change(
    request,
    params,
    (current) => ({ ok: true, ...removePrLink(current, parsed.data.number), number: parsed.data.number }),
    'support_report.pr_link_removed',
  );
}
