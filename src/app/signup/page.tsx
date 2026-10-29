import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { PublicShell } from '@/components/landing/PublicShell';
import { requireVerticalCapability } from '@/lib/verticalPage';
import { selfServeSignupEnabled } from '@/lib/selfServeSignup';
import { getPlan } from '@/lib/plans';
import { SignupClient, SignupSoon } from './SignupClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerDictionary();
  return { title: t.signup.metaTitle, description: t.signup.subtitle };
}

// Self-serve tenant signup, the client half (#1751; the endpoint is #1749).
// INTERNSHIP-only: a MARKETING host is invitation-only (#2501), so the page is
// a 404 there. With SELF_SERVE_SIGNUP off (production, until tenant isolation
// is enforced) it renders an honest "opening soon" state with the enquiry form
// as the way in — never a dead form. The endpoint is the control; this flag
// read only decides which of the two states to show.
export default async function SignupPage() {
  await requireVerticalCapability('mentorship');
  const { t } = await getServerDictionary();
  const s = t.signup;
  // The numbers come from the price list, never from a string (#1730).
  const community = getPlan('community');
  const pairs = String(community?.limits.activePairs ?? '');
  const admins = String(community?.limits.adminSeats ?? '');
  const terms = [
    s.communityPairs.replace('{pairs}', pairs),
    s.communityAdmins.replace('{admins}', admins),
    s.communityNoCard,
    s.communityFreeCore,
  ];

  return (
    <PublicShell showRegister={false} breadcrumb={{ name: s.title, path: '/signup' }}>
      <div className="max-w-5xl mx-auto px-4 py-12 sm:py-16">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 leading-tight">{s.title}</h1>
          <p className="text-lg text-gray-600 mt-4">{s.subtitle}</p>
        </div>

        <div className="mt-10 grid grid-cols-1 md:grid-cols-5 gap-8 items-start">
          <aside className="md:col-span-2 rounded-2xl border border-green-200 bg-green-50 p-6" data-testid="signup-community-terms">
            <h2 className="font-semibold text-gray-900">{s.communityTitle}</h2>
            <ul className="mt-3 space-y-2">
              {terms.map((line) => (
                <li key={line} className="flex items-start gap-2 text-sm text-gray-700">
                  <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0 mt-0.5" />
                  {line}
                </li>
              ))}
            </ul>
            <Link href="/pricing" className="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline">
              {s.pricingLink}
            </Link>
          </aside>
          <div className="md:col-span-3">
            {selfServeSignupEnabled() ? <SignupClient /> : <SignupSoon />}
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
