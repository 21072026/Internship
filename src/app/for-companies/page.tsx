import Link from 'next/link';
import { CheckCircle, Code2, ScrollText, Languages, ShieldCheck } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { CompanyInquiryForm } from '@/components/CompanyInquiryForm';
import { PublicShell } from '@/components/landing/PublicShell';
import { GITHUB_URL } from '@/components/landing/links';
import { RELEASE_NOTES } from '@/lib/releaseNotes';

export const dynamic = 'force-dynamic';

// The first real page a company can land on (#1102). Companies have no
// self-service sign-up, so the page ends in an enquiry form (#1104) rather than
// a register button. The six benefit items are the SAME strings the landing's
// company section uses (landing.audCompany*) — one source of truth, so a claim
// can never drift between the two pages.
export default async function ForCompaniesPage() {
  const { t } = await getServerDictionary();
  const L = t.landing;
  const c = t.forCompanies;

  const items = [
    { t: L.audCompany1T, d: L.audCompany1D },
    { t: L.audCompany2T, d: L.audCompany2D },
    { t: L.audCompany3T, d: L.audCompany3D },
    { t: L.audCompany4T, d: L.audCompany4D },
    { t: L.audCompany5T, d: L.audCompany5D },
    { t: L.audCompany6T, d: L.audCompany6D },
  ];

  const releaseCount = RELEASE_NOTES.length;
  const proof = [
    { t: L.trans1T, d: L.trans1D, icon: Code2 },
    { t: L.trans2T.replace('{n}', String(releaseCount)), d: L.trans2D, icon: ScrollText },
    { t: L.trans4T, d: L.trans4D, icon: Languages },
    { t: L.trans5T, d: L.trans5D, icon: ShieldCheck },
  ];

  // No register button in the chrome: companies have no self-service sign-up
  // (#1102/#1104), so the page ends in the enquiry form instead.
  return (
    <PublicShell showRegister={false}>
      <div className="max-w-5xl mx-auto px-4 py-12 sm:py-16">
        {/* Hero */}
        <div className="text-center max-w-3xl mx-auto">
          <span className="inline-flex items-center gap-2 bg-indigo-100 text-indigo-700 px-4 py-2 rounded-full text-sm font-medium mb-6">
            <CheckCircle className="h-4 w-4" />
            {c.heroBadge}
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight">{L.audCompanyTitle}</h1>
          <p className="text-lg text-gray-600 mt-4">{L.audCompanySubtitle}</p>
        </div>

        {/* What you get — working things first, search last (doc §3.3 order) */}
        <ul className="mt-14 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
          {items.map((it) => (
            <li key={it.t} className="flex items-start gap-3">
              <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-1" />
              <div>
                <h2 className="font-semibold text-gray-900 mb-1">{it.t}</h2>
                <p className="text-gray-600 text-sm leading-relaxed">{it.d}</p>
              </div>
            </li>
          ))}
        </ul>

        {/* Pilot framing */}
        <section className="mt-14 rounded-2xl border border-gray-200 bg-white p-6 sm:p-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">{c.pilotTitle}</h2>
          <p className="text-gray-600 leading-relaxed">{c.pilotBody}</p>
        </section>

        {/* Verifiable proof */}
        <section className="mt-14">
          <h2 className="text-2xl font-bold text-gray-900 text-center mb-8">{c.proofTitle}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {proof.map((p) => (
              <div key={p.t} className="flex items-start gap-4 p-6 rounded-xl border border-gray-200 bg-white">
                <p.icon className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">{p.t}</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{p.d}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
              {L.transLinkGithub}
            </a>
            <Link href="/release-notes" className="text-blue-600 hover:underline">{L.transLinkReleases}</Link>
            <Link href="/features" className="text-blue-600 hover:underline">{L.transLinkFeatures}</Link>
          </div>
        </section>

        {/* Enquiry */}
        <section id="talk" className="mt-14 scroll-mt-16">
          <div className="text-center max-w-2xl mx-auto mb-8">
            <h2 className="text-2xl font-bold text-gray-900">{c.formTitle}</h2>
            <p className="text-gray-600 mt-3">{c.formSubtitle}</p>
          </div>
          <div className="max-w-2xl mx-auto">
            <CompanyInquiryForm />
          </div>
        </section>

        <div className="mt-12 text-center">
          <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">{c.backHome}</Link>
        </div>
      </div>
    </PublicShell>
  );
}
