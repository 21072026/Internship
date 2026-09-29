import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { tenantWhere } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';
import { loadCompanyDetail } from '@/lib/companyDetail';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { getServerDictionary } from '@/i18n/server';
import { CompanyDetailView } from '@/components/CompanyDetailView';

// The rep's view of one account (#2580) — the #2560 account page, read with the
// rep's owner scope and drawn without the ADMIN editors.
//
// Why a sales-side page and not /admin/companies/[id] opened to MENTOR: that
// page sits in the admin shell, whose every other link is an admin screen, and
// renders the external-id editor, which writes through an ADMIN-only route.
// Here the SAME loader (src/lib/companyDetail.ts) runs with `ownerId`, so:
//   - an account none of the rep's relations points at is a 404 — the same
//     answer as another tenant's id or an id that does not exist;
//   - the funnel and interaction lists hold the rep's own records only;
//   - the ADMIN-only columns (VAT id, contact name, contact phone) are stripped
//     by src/lib/companyVisibility.ts exactly as on GET /api/companies/[id].
// No loading.tsx above this page, so notFound() is a real HTTP 404.
export default async function SalesAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) notFound();
  const capabilities = await shellCapabilities(session.user.orgId);
  // A second door behind the layout's: this page is the rep's view only.
  if (!hasSalesSurface(session.user.role, capabilities) || !capabilities.includes('companies')) notFound();

  const tenant = await tenantWhere(session);
  const data = await loadCompanyDetail({
    session,
    id,
    tenant,
    headers: await headers(),
    ownerId: session.user.id,
  });
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
      backHref="/sales/accounts"
      backLabel={t.sales.accounts.back}
      personHref={(r) => `/sales/leads/${r.id}`}
      showAdminEditors={false}
    />
  );
}
