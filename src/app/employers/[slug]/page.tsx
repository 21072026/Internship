import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ExternalLink, MapPin } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { requestHostHeader, resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { loadPublicEmployer } from '@/lib/employerPageStore';
import { formatDate } from '@/lib/relativeTime';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

// The employer the HOST's tenant publishes at this slug, or null. The same
// rule as GET /api/public/employers/[slug]: opted in AND verified, else 404.
async function employerFor(slug: string) {
  const target = await resolvePublicInquiryTarget(requestHostHeader(await headers()));
  if (!target.open || target.vertical !== 'INTERNSHIP' || !target.orgId) return null;
  return loadPublicEmployer(target.orgId, slug);
}

// Its own title and description (#1376 is the site-wide gap; this page does not
// add to it). The description is the company's own copy, cut to a snippet.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const employer = await employerFor(slug);
  if (!employer) return {};
  const { t } = await getServerDictionary();
  const about = employer.about?.replace(/\s+/g, ' ').trim();
  return {
    title: t.employerPage.metaTitle.replace('{company}', employer.name),
    description: about ? (about.length > 160 ? `${about.slice(0, 157)}…` : about) : t.employerPage.metaDescription.replace('{company}', employer.name),
  };
}

// /employers/[slug] (#1867, docs/employer-page.md) — what a candidate may learn
// about an employer: its own copy, industry, size, website and open roles.
// Never its contact e-mail or address.
export default async function EmployerPage({ params }: Props) {
  const { slug } = await params;
  const employer = await employerFor(slug);
  if (!employer) notFound();
  const { t, locale } = await getServerDictionary();
  const e = t.employerPage;

  return (
    <PublicShell breadcrumb={{ name: employer.name, path: `/employers/${slug}` }}>
      <div className="mx-auto max-w-3xl px-4 py-12" data-testid="employer-page">
        <div className="flex items-center gap-4">
          {employer.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a company's own logo URL, not a local asset
            <img src={employer.logoUrl} alt="" className="h-16 w-16 rounded-lg border border-gray-200 object-contain bg-white" />
          )}
          <div className="min-w-0">
            <h1 className="text-3xl font-bold text-gray-900 break-words">{employer.name}</h1>
            <div className="mt-2 flex flex-wrap gap-2 text-sm">
              {employer.industry && <span className="rounded-full bg-gray-100 px-3 py-1 text-gray-700">{employer.industry}</span>}
              {employer.size && <span className="rounded-full bg-gray-100 px-3 py-1 text-gray-700">{e.size.replace('{size}', employer.size)}</span>}
            </div>
          </div>
        </div>

        {employer.websiteUrl && (
          <a
            href={employer.websiteUrl}
            rel="noopener nofollow"
            target="_blank"
            className="mt-4 inline-flex items-center gap-1 text-blue-700 hover:underline"
            data-testid="employer-website"
          >
            {e.website}
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        )}

        {employer.about && (
          <section className="mt-8">
            <h2 className="text-xl font-semibold text-gray-900">{e.about}</h2>
            <p className="mt-2 whitespace-pre-line text-gray-700">{employer.about}</p>
          </section>
        )}

        <section className="mt-10" aria-labelledby="employer-roles">
          <h2 id="employer-roles" className="text-xl font-semibold text-gray-900">{e.openRoles}</h2>
          {employer.roles.length === 0 ? (
            <p className="mt-3 text-gray-600" data-testid="employer-no-roles">{e.noRoles}</p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-200 rounded-lg border border-gray-200" data-testid="employer-roles">
              {employer.roles.map((r) => (
                <li key={r.id} className="p-4">
                  <Link href={`/portal/jobs/${r.id}`} className="font-medium text-blue-700 hover:underline">{r.title}</Link>
                  <p className="mt-1 flex flex-wrap items-center gap-3 text-sm text-gray-600">
                    {r.city && <span className="inline-flex items-center gap-1"><MapPin className="h-4 w-4" aria-hidden="true" />{r.city}</span>}
                    {r.workMode && <span>{r.workMode}</span>}
                    {r.startDate && <span>{e.starts.replace('{date}', formatDate(r.startDate, locale))}</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PublicShell>
  );
}
