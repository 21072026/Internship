import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { ArrowLeft } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { redactCompanyForReader } from '@/lib/companyVisibility';
import { logViewActivity } from '@/lib/activity';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { formatDate } from '@/lib/relativeTime';
import { getServerDictionary } from '@/i18n/server';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { InteractionTypeBadge } from '@/components/InteractionTypeBadge';
import { CompanyExternalIdForm } from '@/components/admin/CompanyExternalIdForm';

// The account detail page (#2560, story #2397): one screen that answers "what
// is the state of this account" — its fields, who to call, every funnel record
// with its stage, owner, trial window and next action, and what happened last.
//
// A SERVER component, so its Prisma reads do not pass through an API route's
// filters. Every read below therefore carries the tenant filter by hand
// (`tenantWhere`/`withinTenant`, #2542): another tenant's company id is a
// `notFound()` — the same answer as an id that does not exist, so the page
// confirms nothing about foreign rows. The admin layout already refuses every
// role but ADMIN; the role check here is a second door, not the first.
//
// It lives in the (unstreamed) route group, outside src/app/admin/loading.tsx,
// so that notFound() is an HTTP 404 and not a not-found screen under a 200 —
// see src/app/(unstreamed)/admin/layout.tsx. The URL is /admin/companies/[id]
// all the same.
//
// Opening the page is a READ of the customer record, so it writes the same
// `company.view` ActivityLog entry as GET /api/companies/[id] (#2433) — same
// action, same window, so opening the page and then its edit dialog records one
// read, not two.
//
// Seams for work that is not on main yet, deliberately left out rather than
// rendered as empty cards: the usage sparkline (#2448, fed by CompanyUsage),
// the account's channels (#2408) and its contact consent (#2577). Each gets a
// section here when it lands.

/** How many funnel records and interactions the page lists. An account holds a
 *  handful of each; the bound only keeps a pathological one from rendering
 *  thousands of rows. */
const RELATION_LIMIT = 100;
const INTERACTION_LIMIT = 10;
/** How far back the "continues an earlier pairing" chain is followed. */
const CHAIN_DEPTH_LIMIT = 10;

function Field({ label, value, testId }: { label: string; value?: string | number | null; testId?: string }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div data-testid={testId}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 dark:text-gray-100 break-words">{value}</dd>
    </div>
  );
}

export default async function AdminCompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') notFound();

  // Module gate: a vertical without the `companies` capability has no account
  // pages, whatever the nav shows. Both verticals carry it today.
  const capabilities = await shellCapabilities(session.user.orgId);
  if (!capabilities.includes('companies')) notFound();

  const tenant = await tenantWhere(session);
  const requestHeaders = await headers();

  const data = await withTenantScope(session, async () => {
    const company = await prisma.company.findFirst({
      where: withinTenant({ id }, tenant),
      include: {
        needs: true,
        mentorships: {
          // The relation carries its own orgId: filtered on it too, so a
          // relation of another tenant pointing at this company (a bad import)
          // is not shown here.
          where: withinTenant({}, tenant),
          orderBy: { startDate: 'desc' },
          take: RELATION_LIMIT,
          select: {
            id: true,
            status: true,
            pipelineStatus: true,
            startDate: true,
            trialStartedAt: true,
            trialEndsAt: true,
            nextActionAt: true,
            nextActionNote: true,
            // The chain link is resolved below, through the tenant filter —
            // not via the `previousRelation` include, which would follow the
            // foreign key into whatever tenant it points at.
            previousRelationId: true,
            mentor: { select: { id: true, fullName: true } },
            mentee: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    if (!company) return null;

    // "Continues an earlier pairing with X, Y" (#2289): the whole
    // previousRelationId chain, newest predecessor first. mentorTransfer only
    // chains relations inside one org, but a chain written by a bad import must
    // not print another tenant's mentor name here, so every earlier relation is
    // read with the same tenant filter as every other row on the page — a link
    // that leaves the tenant simply ends the chain. One query per hop, capped:
    // a reassignment chain is a handful long, and the cap also stops a cycle.
    const chainRows = new Map<string, { mentorName: string; previousRelationId: string | null }>();
    let frontier = [
      ...new Set(company.mentorships.map((r) => r.previousRelationId).filter((v): v is string => !!v)),
    ];
    for (let hop = 0; hop < CHAIN_DEPTH_LIMIT && frontier.length > 0; hop++) {
      const rows = await prisma.mentorshipRelation.findMany({
        where: withinTenant({ id: { in: frontier } }, tenant),
        select: { id: true, previousRelationId: true, mentor: { select: { fullName: true } } },
      });
      for (const row of rows) {
        chainRows.set(row.id, { mentorName: row.mentor.fullName, previousRelationId: row.previousRelationId });
      }
      frontier = [
        ...new Set(
          rows.map((row) => row.previousRelationId).filter((v): v is string => !!v && !chainRows.has(v)),
        ),
      ];
    }
    const relations = company.mentorships.map((r) => {
      const earlierMentors: string[] = [];
      const seen = new Set<string>();
      let cursor = r.previousRelationId;
      while (cursor && !seen.has(cursor) && earlierMentors.length < CHAIN_DEPTH_LIMIT) {
        seen.add(cursor);
        const row = chainRows.get(cursor);
        if (!row) break;
        earlierMentors.push(row.mentorName);
        cursor = row.previousRelationId;
      }
      return { ...r, earlierMentors };
    });

    const interactions = await prisma.interactionLog.findMany({
      where: { relation: withinTenant({ companyId: company.id }, tenant) },
      orderBy: { date: 'desc' },
      take: INTERACTION_LIMIT,
      select: {
        id: true,
        date: true,
        type: true,
        subject: true,
        notes: true,
        relation: { select: { mentee: { select: { id: true, fullName: true } } } },
      },
    });

    await logViewActivity({
      action: 'company.view',
      reader: session.user,
      targetType: 'company',
      targetId: company.id,
      request: { headers: requestHeaders },
    });

    return { company: { ...company, mentorships: relations }, interactions };
  });

  if (!data) notFound();

  const { locale, t } = await getServerDictionary();
  const d = t.companyDetail;
  const stages = await resolvePipelineStages(session.user.orgId, locale);
  // The column rule lives in one place (src/lib/companyVisibility.ts). This page
  // is ADMIN-only, so it passes everything — but a later widening of who may
  // open it inherits the redaction instead of re-deciding it.
  const company = redactCompanyForReader(data.company, session.user.role) as typeof data.company;
  const { interactions } = data;
  const date = (value: Date) => formatDate(value, locale);

  return (
    <div data-testid="company-detail">
      <Link
        href="/admin/companies"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" />
        {d.back}
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="company-detail-name">
            {company.name}
          </h1>
          {company.industry && <p className="mt-1 text-gray-500">{company.industry}</p>}
        </div>
        {company.externalId && (
          <Badge variant="default" data-testid="company-detail-external-id">
            <span className="font-mono">{company.externalId}</span>
          </Badge>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{d.sections.account}</CardTitle>
          </CardHeader>
          <dl className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={d.fields.industry} value={company.industry} />
            <Field label={d.fields.size} value={company.size} />
            <Field label={d.fields.country} value={company.country} />
            <Field label={d.fields.address} value={company.address} />
            <Field label={d.fields.vatId} value={company.vatId} testId="company-detail-vat-id" />
            <Field label={d.fields.quota} value={company.quota} />
            <Field label={d.fields.createdAt} value={date(company.createdAt)} />
          </dl>
          {company.description && (
            <div className="mb-6" data-testid="company-detail-description">
              <p className="text-xs text-gray-500">{d.fields.description}</p>
              <p className="whitespace-pre-line text-sm text-gray-600">{company.description}</p>
            </div>
          )}
          <CompanyExternalIdForm companyId={company.id} initial={company.externalId} labels={d.externalId} />
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{d.sections.contact}</CardTitle>
          </CardHeader>
          <dl className="grid grid-cols-1 gap-4" data-testid="company-detail-contact">
            <Field label={d.fields.contactName} value={company.contactName} testId="company-detail-contact-name" />
            <Field label={d.fields.contactEmail} value={company.contactEmail} />
            <Field label={d.fields.contactPhone} value={company.contactPhone} testId="company-detail-contact-phone" />
          </dl>
          {!company.contactName && !company.contactEmail && !company.contactPhone && (
            <p className="text-sm text-gray-500">{d.notSet}</p>
          )}
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{d.sections.funnel}</CardTitle>
        </CardHeader>
        {company.mentorships.length === 0 ? (
          <p className="text-sm text-gray-500">{d.funnel.empty}</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} aria-label={d.sections.funnel} role="region">
            <table className="w-full text-left text-sm" data-testid="company-detail-relations">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.person}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.stage}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.owner}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.status}</th>
                  <th scope="col" className="py-2 pr-4 font-medium">{d.funnel.trial}</th>
                  <th scope="col" className="py-2 font-medium">{d.funnel.nextAction}</th>
                </tr>
              </thead>
              <tbody>
                {company.mentorships.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-gray-100 align-top last:border-0"
                    data-testid={`company-detail-relation-${r.id}`}
                  >
                    <td className="py-2 pr-4">
                      <Link href={`/admin/candidates/${r.mentee.id}`} className="font-medium text-blue-600 hover:underline">
                        {r.mentee.fullName}
                      </Link>
                      {r.earlierMentors.length > 0 && (
                        <p className="mt-0.5 text-xs text-gray-500" data-testid={`company-detail-relation-chain-${r.id}`}>
                          {d.funnel.continues.replace('{name}', r.earlierMentors.join(', '))}
                        </p>
                      )}
                    </td>
                    <td className="py-2 pr-4" data-testid={`company-detail-relation-stage-${r.id}`}>
                      {stageLabel(stages, r.pipelineStatus, locale)}
                    </td>
                    <td className="py-2 pr-4">{r.mentor.fullName}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={r.status === 'ACTIVE' ? 'success' : 'default'}>
                        {r.status === 'ACTIVE' ? d.funnel.statusActive : d.funnel.statusCompleted}
                      </Badge>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {r.trialStartedAt && r.trialEndsAt
                        ? d.funnel.trialWindow
                            .replace('{start}', date(r.trialStartedAt))
                            .replace('{end}', date(r.trialEndsAt))
                        : r.trialEndsAt
                          ? d.funnel.trialEnds.replace('{date}', date(r.trialEndsAt))
                          : d.notSet}
                    </td>
                    <td className="py-2" data-testid={`company-detail-relation-next-${r.id}`}>
                      {r.nextActionAt || r.nextActionNote ? (
                        <>
                          {r.nextActionAt && <span className="whitespace-nowrap">{date(r.nextActionAt)}</span>}
                          {r.nextActionNote && <p className="text-xs text-gray-600">{r.nextActionNote}</p>}
                        </>
                      ) : (
                        d.notSet
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{d.sections.interactions}</CardTitle>
          </CardHeader>
          {interactions.length === 0 ? (
            <p className="text-sm text-gray-500">{d.interactionsEmpty}</p>
          ) : (
            <ul className="space-y-3" data-testid="company-detail-interactions">
              {interactions.map((i) => (
                <li key={i.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <InteractionTypeBadge type={i.type} />
                    <span className="text-gray-500">{date(i.date)}</span>
                    <span className="text-gray-700">
                      {d.interactionWith.replace('{name}', i.relation.mentee.fullName)}
                    </span>
                  </div>
                  {i.subject && <p className="mt-1 font-medium text-gray-900 dark:text-gray-100">{i.subject}</p>}
                  <p className="mt-0.5 line-clamp-2 text-gray-600">{i.notes}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{d.sections.needs}</CardTitle>
          </CardHeader>
          {company.needs.length === 0 ? (
            <p className="text-sm text-gray-500">{d.needsEmpty}</p>
          ) : (
            <ul className="space-y-1.5">
              {company.needs.map((need) => (
                <li
                  key={need.id}
                  className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-gray-700">{need.position}</span>
                  <span className="text-gray-500">
                    {need.count} × {need.period}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
