import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { orgScoped, resolveOrgId } from '@/lib/orgScope';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
  countInvitationStatuses,
  deriveInvitationStatus,
  isInvitationDeletable,
  isInvitationResendable,
  isInvitationRevocable,
  parseInvitationStatus,
  type InvitationStatus,
} from '@/lib/invitationStatus';

// The invitation status board's data source (#2071).
//
// GET /api/admin/invitations                → JSON rows + per-status counts
// GET /api/admin/invitations?format=csv     → the same filtered set as CSV
//
// Three things this route does NOT inherit and therefore does explicitly:
//
//   1. Role. `InvitationToken` rows name people who have not signed up yet;
//      only an ADMIN may read the org's whole list. (`/api/invite`'s GET is the
//      "my own invitations" view for everybody else and is left as it was.)
//   2. Tenant. `InvitationToken` carries `orgId` but is NOT in TENANT_MODELS
//      (src/lib/orgContext.ts), so the central middleware does not scope it —
//      the `where` is wrapped in orgScoped() by hand, every time.
//   3. Status. Derived in src/lib/invitationStatus.ts, never re-implemented
//      here, so the badge, the filter, the counts and the export agree.

// The board reads one page of rows for a whole tenant. Everything except the
// status is filtered in SQL; the status is derived in memory (one derivation,
// see the module note), so the cap applies to the already-filtered set and
// `truncated` tells the UI when it is looking at a slice.
const BOARD_LIMIT = 2000;

interface BoardRow {
  id: string;
  email: string | null;
  label: string | null;
  role: string;
  used: boolean;
  createdAt: Date;
  expiresAt: Date;
  openedAt: Date | null;
  registeredAt: Date | null;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  invitedBy: { id: string; fullName: string } | null;
}

const ROLE_VALUES = ['ADMIN', 'MENTOR', 'MENTEE'] as const;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// RFC 4180 quoting: wrap in quotes and double any quote inside. The leading
// apostrophe guard keeps a spreadsheet from evaluating a value that starts with
// =, +, - or @ as a formula (an admin exporting invitations is exactly the
// person a CSV-injection payload would be aimed at).
function csvCell(value: string | null | undefined): string {
  const raw = value ?? '';
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function iso(value: Date | null): string {
  return value ? value.toISOString() : '';
}

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const url = new URL(request.url);
    const format = url.searchParams.get('format');

    // Only the export is capped: it renders the whole filtered set in one
    // response, which is the shape worth limiting. The JSON list is polled by
    // the board itself as the admin types.
    if (format === 'csv') {
      const limited = enforceRateLimit(request, 'invitations-export', { limit: 20, windowMs: 60_000 });
      if (limited) return limited;
    }

    return await withTenantScope(session, async () => {
      const orgId = resolveOrgId(session);
      const status = parseInvitationStatus(url.searchParams.get('status'));
      const roleParam = url.searchParams.get('role');
      const role = (ROLE_VALUES as readonly string[]).includes(roleParam ?? '') ? roleParam : null;
      const from = parseDate(url.searchParams.get('from'));
      const to = parseDate(url.searchParams.get('to'));
      const q = (url.searchParams.get('q') ?? '').trim();

      const createdAt: { gte?: Date; lte?: Date } = {};
      if (from) createdAt.gte = from;
      // A date-only "to" means "up to the end of that day" — otherwise picking
      // today as the upper bound returns nothing sent today.
      if (to) createdAt.lte = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('to') ?? '')
        ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1)
        : to;

      const where = orgScoped(
        {
          ...(role ? { role: role as (typeof ROLE_VALUES)[number] } : {}),
          ...(from || to ? { createdAt } : {}),
          ...(q ? { OR: [{ email: { contains: q } }, { label: { contains: q } }] } : {}),
        },
        orgId,
      );

      const rows = (await prisma.invitationToken.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: BOARD_LIMIT,
        // No `token`: the board never needs it, and the flat list it replaces
        // deliberately withheld it too.
        select: {
          id: true,
          email: true,
          label: true,
          role: true,
          used: true,
          createdAt: true,
          expiresAt: true,
          openedAt: true,
          registeredAt: true,
          verifiedAt: true,
          revokedAt: true,
          invitedBy: { select: { id: true, fullName: true } },
        },
      })) as BoardRow[];

      const now = new Date();
      // Counts describe everything the non-status filters matched, so the
      // summary row still answers "how many are expired?" while the table is
      // narrowed to one status.
      const counts = countInvitationStatuses(rows, now);

      const withStatus = rows
        .map((row) => ({ row, status: deriveInvitationStatus(row, now) }))
        .filter((entry) => !status || entry.status === status);

      if (format === 'csv') {
        const header = ['email', 'label', 'role', 'status', 'sent', 'opened', 'registered', 'verified', 'expires', 'revoked', 'invited_by'];
        const lines = [
          header.join(','),
          ...withStatus.map(({ row, status: s }) =>
            [
              csvCell(row.email),
              csvCell(row.label),
              csvCell(row.role),
              csvCell(s),
              csvCell(iso(row.createdAt)),
              csvCell(iso(row.openedAt)),
              csvCell(iso(row.registeredAt)),
              csvCell(iso(row.verifiedAt)),
              csvCell(iso(row.expiresAt)),
              csvCell(iso(row.revokedAt)),
              csvCell(row.invitedBy?.fullName ?? null),
            ].join(','),
          ),
        ];
        // BOM so Excel opens the UTF-8 names (Ayşe, Müller) correctly.
        return new NextResponse(`﻿${lines.join('\r\n')}\r\n`, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="invitations-${now.toISOString().slice(0, 10)}.csv"`,
            'Cache-Control': 'no-store',
          },
        });
      }

      return NextResponse.json({
        invitations: withStatus.map(({ row, status: s }) => ({
          id: row.id,
          email: row.email,
          label: row.label,
          role: row.role,
          status: s satisfies InvitationStatus,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          openedAt: row.openedAt,
          registeredAt: row.registeredAt,
          verifiedAt: row.verifiedAt,
          revokedAt: row.revokedAt,
          invitedByName: row.invitedBy?.fullName ?? null,
          // Precomputed from the shared helper so the checkboxes and the bulk
          // route apply the same rules — the server still re-checks per row.
          canResend: isInvitationResendable(s),
          canRevoke: isInvitationRevocable(s),
          canDelete: isInvitationDeletable(row),
        })),
        counts,
        // What the table is showing (after the status filter); `counts` still
        // describes everything the other filters matched, so the summary row
        // keeps answering "how many are expired?" while the table is narrowed.
        total: withStatus.length,
        truncated: rows.length === BOARD_LIMIT,
      });
    });
  } catch (error) {
    console.error('Invitation board error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
