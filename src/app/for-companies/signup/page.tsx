import type { Metadata } from 'next';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { CompanySignupForm } from '@/components/CompanySignupForm';
import { requestVerticalHas, requireVerticalCapability } from '@/lib/verticalPage';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  if (!(await requestVerticalHas('placements'))) return {};
  const { t } = await getServerDictionary();
  return { title: t.companySignup.metaTitle, description: t.companySignup.subtitle };
}

// Employer self-signup (#1865, docs/company-verification.md). The account starts
// PENDING and reaches no candidate until it is verified — the page says so up
// front rather than letting an employer discover it after posting a role.
export default async function CompanySignupPage() {
  await requireVerticalCapability('placements');
  const { t } = await getServerDictionary();
  const s = t.companySignup;
  return (
    <PublicShell showRegister={false} breadcrumb={{ name: s.title, path: '/for-companies/signup' }}>
      <div className="mx-auto max-w-xl px-4 py-12">
        <h1 className="text-3xl font-bold text-gray-900">{s.title}</h1>
        <p className="mt-3 text-gray-600">{s.subtitle}</p>
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{s.verificationNote}</p>
        <div className="mt-8">
          <CompanySignupForm />
        </div>
      </div>
    </PublicShell>
  );
}
