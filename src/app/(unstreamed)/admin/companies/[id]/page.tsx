import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { tenantWhere } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { loadCompanyDetail } from '@/lib/companyDetail';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { getServerDictionary } from '@/i18n/server';
import { CompanyDetailView } from '@/components/CompanyDetailView';

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
// The read and the screen are shared with the sales rep's own view of an
// account (/sales/accounts/[id], #2580): src/lib/companyDetail.ts and
// src/components/CompanyDetailView.tsx. This page passes no owner scope, so its
// queries are the ones #2560 shipped.
//
// Seams for work that is not on main yet, deliberately left out rather than
// rendered as empty cards: the usage sparkline (#2448, fed by CompanyUsage),
// the account's channels (#2408) and its contact consent (#2577). Each gets a
// section here when it lands.

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
  const data = await loadCompanyDetail({ session, id, tenant, headers: requestHeaders });
  if (!data) notFound();

  const { locale, t } = await getServerDictionary();
  const stages = await resolvePipelineStages(session.user.orgId, locale);
  return (
    <CompanyDetailView
      data={data}
      role={session.user.role}
      t={t}
      locale={locale}
      stages={stages}
      backHref="/admin/companies"
      backLabel={t.companyDetail.back}
      personHref={(r) => `/admin/candidates/${r.mentee.id}`}
      showAdminEditors
    />
  );
}
