import Link from 'next/link';
import {
  GraduationCap, Users, Building2, ArrowRight, CheckCircle,
  GitBranch, CalendarClock, BarChart3, ShieldCheck,
} from 'lucide-react';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { roleHome } from '@/lib/roleHome';
import { getServerDictionary } from '@/i18n/server';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session) redirect(roleHome(session.user.role));

  const { locale, t } = await getServerDictionary();
  const L = t.landing;

  const features = [
    { icon: GitBranch, color: 'blue', title: L.fPipelineT, desc: L.fPipelineD },
    { icon: Users, color: 'green', title: L.fMentorT, desc: L.fMentorD },
    { icon: Building2, color: 'purple', title: L.fCompanyT, desc: L.fCompanyD },
    { icon: CalendarClock, color: 'amber', title: L.fCommsT, desc: L.fCommsD },
    { icon: BarChart3, color: 'sky', title: L.fAnalyticsT, desc: L.fAnalyticsD },
    { icon: ShieldCheck, color: 'rose', title: L.fPrivacyT, desc: L.fPrivacyD },
  ];
  const iconBg: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-600', green: 'bg-green-100 text-green-600',
    purple: 'bg-purple-100 text-purple-600', amber: 'bg-amber-100 text-amber-600',
    sky: 'bg-sky-100 text-sky-600', rose: 'bg-rose-100 text-rose-600',
  };

  const roles = [
    { name: L.roleAdmin, desc: L.roleAdminD, c: 'bg-red-50 border-red-100 text-red-900', badge: 'bg-red-100 text-red-700' },
    { name: L.roleMentor, desc: L.roleMentorD, c: 'bg-blue-50 border-blue-100 text-blue-900', badge: 'bg-blue-100 text-blue-700' },
    { name: L.roleMentee, desc: L.roleMenteeD, c: 'bg-green-50 border-green-100 text-green-900', badge: 'bg-green-100 text-green-700' },
    { name: L.roleCompany, desc: L.roleCompanyD, c: 'bg-indigo-50 border-indigo-100 text-indigo-900', badge: 'bg-indigo-100 text-indigo-700' },
  ];

  const stages = [L.stageApply, L.stageInterview, L.stageInternship, L.stageHired];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-2">
              <GraduationCap className="h-8 w-8 text-blue-600" />
              <span className="text-xl font-bold text-gray-900">InternshipCRM</span>
            </div>
            <div className="flex items-center gap-3 sm:gap-4">
              <LanguageSwitcher current={locale} />
              <Link href="/auth/signin" className="text-gray-600 hover:text-gray-900 font-medium transition-colors">
                {L.signIn}
              </Link>
              <Link href="/auth/register" className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors">
                {L.register}
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 sm:py-24 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-2 rounded-full text-sm font-medium mb-8">
            <CheckCircle className="h-4 w-4" />
            {L.badge}
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-6 leading-tight">
            {L.heroTitle} <span className="text-blue-600">{L.heroAccent}</span>
          </h1>
          <p className="text-lg sm:text-xl text-gray-600 mb-10 max-w-2xl mx-auto">{L.heroSubtitle}</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/auth/signin" className="inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-8 py-4 rounded-xl font-semibold hover:bg-blue-700 transition-colors text-lg">
              {L.getStarted} <ArrowRight className="h-5 w-5" />
            </Link>
            <Link href="/auth/register" className="inline-flex items-center justify-center gap-2 border-2 border-gray-300 text-gray-700 px-8 py-4 rounded-xl font-semibold hover:border-blue-400 hover:text-blue-600 transition-colors text-lg">
              {L.registerInvite}
            </Link>
          </div>
        </div>
      </section>

      {/* Pipeline diagram */}
      <section className="py-16 px-4">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">{L.pipelineTitle}</h2>
          <p className="text-gray-600 mb-10">{L.pipelineSubtitle}</p>
          <div className="overflow-x-auto">
            <svg viewBox="0 0 920 160" className="w-full min-w-[680px] max-w-4xl mx-auto" role="img" aria-label={L.pipelineTitle}>
              <defs>
                <linearGradient id="pg" x1="0" x2="1">
                  <stop offset="0" stopColor="#3b82f6" />
                  <stop offset="1" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              {stages.map((label, i) => {
                const x = 30 + i * 222;
                return (
                  <g key={i}>
                    <rect x={x} y={50} width="180" height="60" rx="14" fill="url(#pg)" opacity={0.12 + i * 0.06} />
                    <rect x={x} y={50} width="180" height="60" rx="14" fill="none" stroke="#6366f1" strokeWidth="1.5" />
                    <circle cx={x + 30} cy={80} r="14" fill="#6366f1" />
                    <text x={x + 30} y={85} textAnchor="middle" fill="#fff" fontSize="13" fontWeight="700">{i + 1}</text>
                    <text x={x + 58} y={85} fill="#1e293b" fontSize="15" fontWeight="600">{label}</text>
                    {i < stages.length - 1 && (
                      <g>
                        <line x1={x + 180} y1={80} x2={x + 218} y2={80} stroke="#94a3b8" strokeWidth="2" />
                        <polygon points={`${x + 218},80 ${x + 210},75 ${x + 210},85`} fill="#94a3b8" />
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <p className="text-sm text-gray-500 mt-6 max-w-xl mx-auto italic">{L.pipelineNote}</p>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-4 bg-white">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{L.featuresTitle}</h2>
            <p className="text-gray-600 mt-2">{L.featuresSubtitle}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="p-7 rounded-2xl border border-gray-100 hover:border-blue-200 hover:shadow-lg transition-all">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${iconBg[f.color]}`}>
                  <f.icon className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{f.title}</h3>
                <p className="text-gray-600 text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Roles */}
      <section className="py-16 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10">{L.rolesTitle}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {roles.map((r) => (
              <div key={r.name} className={`flex items-start gap-4 p-6 rounded-xl border ${r.c}`}>
                <div className={`w-10 h-10 rounded-lg ${r.badge} flex items-center justify-center flex-shrink-0`}>
                  <span className="font-bold text-sm">{r.name[0]}</span>
                </div>
                <div>
                  <h3 className="font-semibold mb-1">{r.name}</h3>
                  <p className="text-sm opacity-80">{r.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto text-center bg-gradient-to-r from-blue-600 to-indigo-600 rounded-3xl p-10 sm:p-14">
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">{L.ctaTitle}</h2>
          <p className="text-blue-100 mb-8">{L.ctaSubtitle}</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/auth/signin" className="inline-flex items-center justify-center gap-2 bg-white text-blue-700 px-8 py-3.5 rounded-xl font-semibold hover:bg-blue-50 transition-colors">
              {L.getStarted} <ArrowRight className="h-5 w-5" />
            </Link>
            <Link href="/auth/register" className="inline-flex items-center justify-center gap-2 border-2 border-white/60 text-white px-8 py-3.5 rounded-xl font-semibold hover:bg-white/10 transition-colors">
              {L.registerInvite}
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white py-8 px-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-gray-500 text-sm">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-5 w-5 text-blue-600" />
            <span className="font-semibold text-gray-700">InternshipCRM</span>
          </div>
          <p>© {new Date().getFullYear()} InternshipCRM. {L.footer}</p>
          <Link href="/privacy" className="hover:text-gray-700">{t.privacy.title}</Link>
        </div>
      </footer>
    </div>
  );
}
