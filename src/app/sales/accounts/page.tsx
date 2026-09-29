import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { getServerDictionary } from '@/i18n/server';
import { Card } from '@/components/ui/Card';

// The rep's own accounts (#2580): the companies behind at least one of THEIR
// relations, in their tenant — the MENTOR `company` scope of
// src/lib/authzScope.ts narrowed to the owner side. The count next to each is
// the rep's own records there, never the account's total (the same rule
// docs/role-access-matrix.md sets for `_count.mentorships` on the list route).

const ACCOUNT_LIMIT = 200;

export default async function SalesAccountsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect('/auth/signin');
  const capabilities = await shellCapabilities(session.user.orgId);
  if (!capabilities.includes('companies')) notFound();

  const tenant = await tenantWhere(session);
  const own = withinTenant({ mentorId: session.user.id }, tenant);
  const companies = await prisma.company.findMany({
    where: withinTenant({ mentorships: { some: own } }, tenant),
    orderBy: { name: 'asc' },
    take: ACCOUNT_LIMIT,
    select: {
      id: true,
      name: true,
      industry: true,
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
                  <th scope="col" className="py-2 font-medium">{s.records}</th>
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
                    <td className="py-2 text-gray-600">{c._count.mentorships}</td>
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
