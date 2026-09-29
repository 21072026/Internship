import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { getServerDictionary } from '@/i18n/server';
import { Card } from '@/components/ui/Card';
import { marketingEmailPermissionFilter } from '@/lib/contactPermission';
import { marketingEmailAllowed } from '@/lib/contactPermissionRule';

// The rep's own accounts (#2580): the companies behind at least one of THEIR
// relations, in their tenant — the MENTOR `company` scope of
// src/lib/authzScope.ts narrowed to the owner side. The count next to each is
// the rep's own records there, never the account's total (the same rule
// docs/role-access-matrix.md sets for `_count.mentorships` on the list route).

const ACCOUNT_LIMIT = 200;

export default async function SalesAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  // "With provable e-mail permission" (#2577) — the same filter as
  // /admin/companies, from the one rule. Any other value is no filter.
  const onlyPermitted = (await searchParams).permission === 'email';
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/signin');
  const capabilities = await shellCapabilities(session.user.orgId);
  // The second door, like the detail pages: Next renders a layout and its page
  // in parallel, so the layout's redirect is not what stops these queries.
  if (!hasSalesSurface(session.user.role, capabilities) || !capabilities.includes('companies')) notFound();

  const tenant = await tenantWhere(session);
  const own = withinTenant({ mentorId: session.user.id }, tenant);
  const companies = await prisma.company.findMany({
    where: withinTenant(
      onlyPermitted ? { AND: [{ mentorships: { some: own } }, marketingEmailPermissionFilter()] } : { mentorships: { some: own } },
      tenant,
    ),
    orderBy: { name: 'asc' },
    take: ACCOUNT_LIMIT,
    select: {
      id: true,
      name: true,
      industry: true,
      contactEmail: true,
      contactPermissions: {
        where: { channel: 'EMAIL' },
        select: { channel: true, basis: true, revokedAt: true, confirmedAt: true, address: true },
      },
      _count: { select: { mentorships: { where: own } } },
    },
  });

  const { t } = await getServerDictionary();
  const s = t.sales.accounts;

  return (
    <div data-testid="sales-accounts">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.title}</h1>
        <p className="text-gray-500 mt-1">{s.subtitle}</p>
      </div>
      <nav className="mb-4 flex gap-2 text-sm" aria-label={s.permission} data-testid="sales-accounts-permission-filter">
        <Link
          href="/sales/accounts"
          aria-current={onlyPermitted ? undefined : 'page'}
          className={`rounded-full px-3 py-1 ${onlyPermitted ? 'bg-gray-100 text-gray-700' : 'bg-gray-900 text-white'}`}
        >
          {s.permissionAll}
        </Link>
        <Link
          href="/sales/accounts?permission=email"
          aria-current={onlyPermitted ? 'page' : undefined}
          data-testid="sales-accounts-permission-email"
          className={`rounded-full px-3 py-1 ${onlyPermitted ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700'}`}
        >
          {s.permissionEmail}
        </Link>
      </nav>
      <Card>
        {companies.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="sales-accounts-empty">{s.empty}</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} aria-label={s.title} role="region">
            <table className="w-full text-left text-sm" data-testid="sales-accounts-table">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th scope="col" className="py-2 pr-4 font-medium">{s.name}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{s.industry}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{s.records}</th>
                  <th scope="col" className="py-2 font-medium">{s.permission}</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => (
                  <tr key={c.id} className="border-b border-gray-100 last:border-0" data-testid={`sales-account-${c.id}`}>
                    <td className="py-2 pr-4">
                      <Link href={`/sales/accounts/${c.id}`} className="font-medium text-blue-600 hover:underline">
                        {c.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-gray-600">{c.industry ?? '—'}</td>
                    <td className="py-2 pr-4 text-gray-600">{c._count.mentorships}</td>
                    <td className="py-2 text-gray-600" data-testid={`sales-account-permission-${c.id}`}>
                      {c.contactEmail && marketingEmailAllowed(c.contactPermissions[0], c.contactEmail) ? s.permissionYes : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
