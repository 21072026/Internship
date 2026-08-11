import Link from 'next/link';
import { GraduationCap, PlayCircle, RefreshCw, ShieldCheck, ArrowRight } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { IS_DEMO_MODE } from '@/lib/demoMode';

const PRODUCTION_URL = 'https://crm.ersah.in';
const DEMO_URL = 'https://crm-demo.ersah.in';

// Demo credentials exposed publicly — these are the only accounts in the demo
// DB; the reset script recreates them every hour.
const DEMO_CREDENTIALS = [
  { role: 'admin', email: 'demo-admin@ersah.in', password: 'Demo1234!' },
  { role: 'mentor', email: 'demo-mentor@ersah.in', password: 'Demo1234!' },
  { role: 'mentee', email: 'demo-mentee@ersah.in', password: 'Demo1234!' },
] as const;

export const metadata = {
  title: 'Live Demo — InternshipCRM',
  description:
    'Explore InternshipCRM with real data — no sign-up required. The demo database resets every hour.',
};

export default async function DemoPage() {
  const { t } = await getServerDictionary();
  const d = t.demoMode;

  const features = [
    { icon: PlayCircle, text: d.pageSubtitle },
    { icon: RefreshCw, text: d.resetNote },
    { icon: ShieldCheck, text: d.noCommitment },
  ];

  const roleLabel = (role: string) => {
    if (role === 'admin') return d.roles.admin;
    if (role === 'mentor') return d.roles.mentor;
    return d.roles.mentee;
  };

  const roleColor: Record<string, string> = {
    admin: 'bg-blue-100 text-blue-700',
    mentor: 'bg-green-100 text-green-700',
    mentee: 'bg-purple-100 text-purple-700',
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50">
      {/* Nav */}
      <header className="px-6 py-4 border-b border-blue-100 bg-white/80 backdrop-blur">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/" className="inline-flex items-center gap-2 font-semibold text-blue-700">
            <GraduationCap className="h-5 w-5" />
            InternshipCRM
          </Link>
          <Link
            href={PRODUCTION_URL}
            className="text-sm text-gray-600 hover:text-blue-700 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            {d.ctaButton} →
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-16">
        {/* Hero */}
        <div className="text-center mb-12">
          <span className="inline-block mb-4 rounded-full bg-amber-100 px-4 py-1 text-sm font-medium text-amber-800">
            {IS_DEMO_MODE ? 'You are already in demo mode' : 'Interactive Demo'}
          </span>
          <h1 className="text-4xl font-bold text-gray-900 mb-4">{d.pageTitle}</h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto">{d.pageBody}</p>
        </div>

        {/* Feature chips */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
          {features.map((f) => (
            <div
              key={f.text}
              className="flex items-start gap-3 rounded-xl bg-white border border-gray-200 p-4 shadow-sm"
            >
              <f.icon className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm text-gray-700">{f.text}</p>
            </div>
          ))}
        </div>

        {/* Credentials + CTA */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Demo login panel */}
          <div
            className="rounded-2xl bg-white border border-gray-200 shadow-sm p-6"
            data-testid="demo-credentials-panel"
          >
            <h2 className="text-lg font-semibold text-gray-900 mb-1">{d.loginHeading}</h2>
            <p className="text-sm text-gray-500 mb-4">{d.loginHint}</p>

            <div className="space-y-3">
              {DEMO_CREDENTIALS.map((c) => (
                <div
                  key={c.role}
                  className="rounded-lg border border-gray-100 bg-gray-50 p-3"
                  data-testid={`demo-credential-${c.role}`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${roleColor[c.role]}`}>
                      {roleLabel(c.role)}
                    </span>
                  </div>
                  <p className="text-sm font-mono text-gray-700">{c.email}</p>
                  <p className="text-sm font-mono text-gray-500">{c.password}</p>
                </div>
              ))}
            </div>

            <Link
              href={`${IS_DEMO_MODE ? '' : DEMO_URL}/auth/signin`}
              className="mt-6 flex items-center justify-center gap-2 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
              data-testid="demo-signin-link"
              {...(!IS_DEMO_MODE ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            >
              <PlayCircle className="h-4 w-4" aria-hidden="true" />
              {d.openDemo}
            </Link>
          </div>

          {/* Production CTA */}
          <div className="rounded-2xl bg-blue-700 shadow-sm p-6 flex flex-col justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white mb-2">{d.ctaHeading}</h2>
              <p className="text-sm text-blue-200 mb-6">{d.ctaBody}</p>
            </div>
            <div className="space-y-3">
              <Link
                href={`${PRODUCTION_URL}/auth/register`}
                className="flex items-center justify-center gap-2 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-50 transition-colors"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="demo-production-cta"
              >
                {d.ctaButton} <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                href="/"
                className="flex items-center justify-center gap-2 w-full rounded-lg border border-blue-500 px-4 py-2.5 text-sm font-medium text-blue-200 hover:bg-blue-600 transition-colors"
              >
                {d.learnMore}
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
