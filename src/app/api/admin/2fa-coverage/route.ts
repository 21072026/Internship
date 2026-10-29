import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { require2faModeOf } from '@/lib/twoFactorPolicy';
import { coverageFor, coveragePercentage, rolesCoveredBy, TWO_FACTOR_ROLES, type RoleCoverage } from '@/lib/twoFactorPolicyRule';
import { toCsv } from '@/lib/reports/render';

const PER_PAGE_DEFAULT = 25;
const PER_PAGE_MAX = 100;

// GET — two-factor enrolment coverage of the caller's tenant (#1644): per role,
// how many ACTIVE accounts exist and how many of them have 2FA on, plus the
// people who do not — the list an admin needs before switching the policy to
// a stricter mode, and the evidence a security review asks for ("97 of 104",
// not "we support 2FA").
//
// Org-scoped SERVER-SIDE through tenantWhere(session) — never a query param —
// and admin-only: a non-admin gets 403. `?format=csv` streams the full list of
// accounts without 2FA; otherwise the list is paginated (`page`, `perPage`).
// Deactivated accounts are left out of both: they cannot sign in, so the gate
// never holds them and counting them would understate the coverage.
export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  return withTenantScope(session, async () => {
    const tenant = await tenantWhere(session);
    const url = new URL(request.url);
    const format = url.searchParams.get('format');

    const [totals, enabled, mode] = await Promise.all([
      prisma.user.groupBy({ by: ['role'], where: withinTenant({ isActive: true }, tenant), _count: { _all: true } }),
      prisma.user.groupBy({ by: ['role'], where: withinTenant({ isActive: true, twoFactorEnabled: true }, tenant), _count: { _all: true } }),
      require2faModeOf(await settingsOrgOf(session)),
    ]);
    const count = (rows: { role: string; _count: { _all: number } }[], role: string) =>
      rows.find((r) => r.role === role)?._count._all ?? 0;
    const roles: RoleCoverage[] = TWO_FACTOR_ROLES.map((role) => {
      const t = count(totals, role);
      const e = count(enabled, role);
      return { role, total: t, enabled: e, percentage: coveragePercentage(e, t) };
    });

    const missingWhere = withinTenant({ isActive: true, twoFactorEnabled: false }, tenant);
    const missingSelect = { id: true, fullName: true, email: true, role: true, lastLoginAt: true } as const;
    // `id` last: names repeat, and without a total order LIMIT/OFFSET may split
    // a run of equal names differently per page (one person twice, another
    // never) — the same fix as src/app/api/mentors/route.ts.
    const order = [{ role: 'asc' as const }, { fullName: 'asc' as const }, { id: 'asc' as const }];

    if (format === 'csv') {
      const users = await prisma.user.findMany({ where: missingWhere, select: missingSelect, orderBy: order });
      const csv = toCsv({
        name: '2fa-coverage',
        columns: ['name', 'email', 'role', 'last_sign_in'],
        rows: users.map((u) => [u.fullName, u.email, u.role, u.lastLoginAt ? u.lastLoginAt.toISOString() : '']),
      });
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="2fa-coverage-${new Date().toISOString().slice(0, 10)}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
    const perPage = Math.min(PER_PAGE_MAX, Math.max(1, Number.parseInt(url.searchParams.get('perPage') ?? '', 10) || PER_PAGE_DEFAULT));
    const [missingTotal, items] = await Promise.all([
      prisma.user.count({ where: missingWhere }),
      prisma.user.findMany({ where: missingWhere, select: missingSelect, orderBy: order, skip: (page - 1) * perPage, take: perPage }),
    ]);

    return NextResponse.json(
      {
        policy: mode,
        roles,
        overall: coverageFor(roles, TWO_FACTOR_ROLES),
        // What the CURRENT policy holds at the gate, for the line next to the select.
        inScope: coverageFor(roles, rolesCoveredBy(mode)),
        missing: { total: missingTotal, page, perPage, items },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  });
}
