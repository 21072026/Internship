import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { Building2, Columns3, AlertTriangle } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getAttentionItems } from '@/lib/mentorAttention';
import { hasSalesSurface, SALES_ATTENTION_REASONS } from '@/lib/salesSurface';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { formatDate } from '@/lib/relativeTime';
import { getServerDictionary } from '@/i18n/server';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { MentorAttentionQueue } from '@/components/MentorAttentionQueue';

// The sales rep's dashboard (#2580): their own attention queue and their own
// records. Every read is the rep's rows only (`mentorId = self`) AND the rep's
// tenant (`withinTenant`, #2542) — a server component, so no API-route filter
// runs in between and both halves are written here by hand.

/** An open book is a few dozen records; the bound keeps a huge one cheap. The
 *  board lists everything. */
const RECORD_LIMIT = 100;

export default async function SalesDashboard() {
  const session = await getServerSession(authOptions);
  // The layout gates this, but a session can be revoked between the two.
  if (!session?.user?.id) redirect('/auth/signin');
  // The second door, like the detail pages: Next renders a layout and its page
  // in parallel, so the layout's redirect is not what stops these queries.
  if (!hasSalesSurface(session.user.role, await shellCapabilities(session.user.orgId))) notFound();

  const tenant = await tenantWhere(session);
  const own = withinTenant({ mentorId: session.user.id }, tenant);

  const [records, openCount, accountCount, attention, dict] = await Promise.all([
    prisma.mentorshipRelation.findMany({
      where: own,
      orderBy: { startDate: 'desc' },
      take: RECORD_LIMIT,
      select: {
        id: true,
        status: true,
        pipelineStatus: true,
        nextActionAt: true,
        nextActionNote: true,
        trialEndsAt: true,
        mentee: { select: { id: true, fullName: true } },
        company: { select: { id: true, name: true } },
      },
    }),
    prisma.mentorshipRelation.count({ where: withinTenant({ mentorId: session.user.id, status: 'ACTIVE' as const }, tenant) }),
    prisma.company.count({ where: withinTenant({ mentorships: { some: own } }, tenant) }),
    getAttentionItems(session.user.id, {
      reasons: SALES_ATTENTION_REASONS,
      relationWhere: withinTenant({}, tenant),
    }),
    getServerDictionary(),
  ]);
  const { t, locale } = dict;
  const s = t.sales;
  const stages = await resolvePipelineStages(session.user.orgId, locale);
  const date = (value: Date) => formatDate(value, locale, { timeZone: 'UTC' });

  return (
    <div data-testid="sales-dashboard">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.dashboard.title}</h1>
        <p className="text-gray-500 mt-1">{s.dashboard.subtitle}</p>
      </div>

      <MentorAttentionQueue items={attention.items} t={t} hrefBase="/sales/leads" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        <Card>
          <Link href="/sales/board" className="flex items-center gap-4" data-testid="sales-stat-open">
            <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
              <Columns3 className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{openCount}</p>
              <p className="text-sm text-gray-500">{s.stats.open}</p>
            </div>
          </Link>
        </Card>
        <Card>
          <Link href="/sales/accounts" className="flex items-center gap-4" data-testid="sales-stat-accounts">
            <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center">
              <Building2 className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{accountCount}</p>
              <p className="text-sm text-gray-500">{s.stats.accounts}</p>
            </div>
          </Link>
        </Card>
        <Card>
          <div className="flex items-center gap-4" data-testid="sales-stat-attention">
            <div className="w-12 h-12 bg-amber-100 rounded-xl flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{attention.items.length}</p>
              <p className="text-sm text-gray-500">{s.stats.attention}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{s.records.title}</CardTitle>
        </CardHeader>
        {records.length === 0 ? (
          <p className="text-sm text-gray-500" data-testid="sales-records-empty">{s.records.empty}</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} aria-label={s.records.title} role="region">
            <table className="w-full text-left text-sm" data-testid="sales-records">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th scope="col" className="py-2 pr-4 font-medium">{s.records.person}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{s.records.company}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{s.records.stage}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{s.records.nextAction}</th>
                  <th scope="col" className="py-2 font-medium">{s.records.trial}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 align-top last:border-0" data-testid={`sales-record-${r.id}`}>
                    <td className="py-2 pr-4">
                      <Link href={`/sales/leads/${r.id}`} className="font-medium text-blue-600 hover:underline">
                        {r.mentee.fullName}
                      </Link>
                      {r.status !== 'ACTIVE' && (
                        <Badge variant="default" className="ml-2 text-xs">{s.lead.statusCompleted}</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {r.company ? (
                        <Link href={`/sales/accounts/${r.company.id}`} className="text-gray-700 hover:underline">
                          {r.company.name}
                        </Link>
                      ) : (
                        s.records.none
                      )}
                    </td>
                    <td className="py-2 pr-4">{stageLabel(stages, r.pipelineStatus, locale)}</td>
                    <td className="py-2 pr-4">
                      {r.nextActionAt || r.nextActionNote ? (
                        <>
                          {r.nextActionAt && <span className="whitespace-nowrap">{date(r.nextActionAt)}</span>}
                          {r.nextActionNote && <p className="text-xs text-gray-600">{r.nextActionNote}</p>}
                        </>
                      ) : (
                        s.records.none
                      )}
                    </td>
                    <td className="py-2 whitespace-nowrap">{r.trialEndsAt ? date(r.trialEndsAt) : s.records.none}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {records.length === RECORD_LIMIT && (
              <p className="pt-3 text-xs text-gray-500">{s.records.more.replace('{n}', String(RECORD_LIMIT))}</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
