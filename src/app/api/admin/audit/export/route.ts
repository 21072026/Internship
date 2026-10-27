import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withinTenant } from '@/lib/tenantFilter';
import { auditWhereFor } from '@/lib/auditQuery';
import { logActivity } from '@/lib/activity';
import { AUDIT_EXPORT_MAX_ROWS, auditCsvHeader, auditCsvLine } from '@/lib/auditRetentionRule';

const CHUNK = 1000;

// GET — the audit trail as CSV (#1585): EVERY row the viewer's filter matches,
// not the visible page — the same query params, the same builder
// (src/lib/auditQuery.ts), so the file cannot drift from the screen.
//
// Behind `audit.export`, a separate permission from `audit.read`: a read-only
// OBSERVER can look at the trail but not carry it away (403 + a denial row),
// because a file leaves every control this product has.
//
// Bounded: at most AUDIT_EXPORT_MAX_ROWS (newest first), read in keyset chunks
// and streamed, so a whole table is never held in memory. A cut file says so in
// `X-Export-Truncated: 1` with the full count in `X-Export-Total`.
//
// The export itself is recorded (`audit.exported` in the ActivityLog), with the
// row count and the filter — never the rows.
//
// There is deliberately no DELETE next to this route, nor anywhere else: only
// the age-based retention sweep may remove an audit row.
export async function GET(request: Request) {
  const gate = await requirePermission('audit.export', { request, listing: true });
  if ('error' in gate) return gate.error;

  const sp = new URL(request.url).searchParams;
  const built = await auditWhereFor(sp, gate);
  if (built === 'invalid_date') return NextResponse.json({ error: 'invalid_date' }, { status: 400 });
  const { where, tenant } = built;

  const total = await prisma.auditLog.count({ where });
  const limit = Math.min(total, AUDIT_EXPORT_MAX_ROWS);
  const filter = ['action', 'actor', 'targetId', 'from', 'to']
    .map((k) => [k, sp.get(k)?.trim()] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  await logActivity({
    action: 'audit.exported',
    actorId: gate.actor.id,
    actorEmail: gate.session.user?.email ?? null,
    targetType: 'system',
    detail: `rows=${limit}${total > limit ? ` of ${total}` : ''}${filter ? ` ${filter}` : ''}`.slice(0, 191),
    request,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(auditCsvHeader()));
        let sent = 0;
        let after: { createdAt: Date; id: string } | null = null;
        while (sent < limit) {
          const page: { id: string; action: string; actorId: string; targetId: string | null; detail: string | null; createdAt: Date }[] =
            await prisma.auditLog.findMany({
              where: after
                ? {
                    AND: [
                      where,
                      {
                        OR: [
                          { createdAt: { lt: after.createdAt } },
                          { createdAt: after.createdAt, id: { lt: after.id } },
                        ],
                      },
                    ],
                  }
                : where,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: Math.min(CHUNK, limit - sent),
              select: { id: true, action: true, actorId: true, targetId: true, detail: true, createdAt: true },
            });
          if (page.length === 0) break;
          // E-mails looked up inside the tenant: a foreign or deleted id stays blank.
          const ids = [...new Set(page.map((r) => r.actorId))];
          const people = await prisma.user.findMany({
            where: withinTenant<Prisma.UserWhereInput>({ id: { in: ids } }, tenant),
            select: { id: true, email: true },
          });
          const emailOf = new Map(people.map((p) => [p.id, p.email]));
          controller.enqueue(
            encoder.encode(page.map((r) => auditCsvLine({ ...r, actorEmail: emailOf.get(r.actorId) ?? null })).join('')),
          );
          sent += page.length;
          const last = page[page.length - 1];
          after = { createdAt: last.createdAt, id: last.id };
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
      'X-Export-Total': String(total),
      'X-Export-Rows': String(limit),
      ...(total > limit ? { 'X-Export-Truncated': '1' } : {}),
    },
  });
}
