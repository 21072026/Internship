import Link from 'next/link';
import {
  GraduationCap, ArrowRight, ArrowDown, CheckCircle, Users, Building2, Briefcase,
  Github, ShieldCheck, Languages, ScrollText, Code2,
} from 'lucide-react';
import { getFeatures } from '@/lib/features';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { roleHome } from '@/lib/roleHome';
import { getServerDictionary } from '@/i18n/server';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { VersionFooter } from '@/components/VersionFooter';
import { BetaBadge } from '@/components/BetaBadge';
import { APP_VERSION } from '@/lib/version';
import { RELEASE_NOTES } from '@/lib/releaseNotes';

const GITHUB_URL = 'https://github.com/21072026/Internship';

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  if (session) redirect(roleHome(session.user.role));

  const { locale, t } = await getServerDictionary();
  const L = t.landing;

  // Each audience now has a door of its own: mentors apply at /apply-as-mentor
  // (#1072), companies ask for a look at /for-companies (#1102/#1104). Neither
  // may point at /auth/register — token-less sign-up always creates a MENTEE,
  // so a mentor landing there would silently become a mentee.
  const mentorHref = '/apply-as-mentor';
  const companyHref = '/for-companies';

  // Fed from the single-source catalogue (#584/#588): the landing shows the
  // featured subset; /features shows everything.
  const features = getFeatures(t).filter((f) => f.featured);
  const iconBg: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-600', green: 'bg-green-100 text-green-600',
    purple: 'bg-purple-100 text-purple-600', amber: 'bg-amber-100 text-amber-600',
    teal: 'bg-teal-100 text-teal-600', orange: 'bg-orange-100 text-orange-600',
    sky: 'bg-sky-100 text-sky-600', rose: 'bg-rose-100 text-rose-600',
    indigo: 'bg-indigo-100 text-indigo-600',
  };

  const heroChips = [L.chipStages, L.chipRoles, L.chipLangs, L.chipGdpr];

  // The loop: what each side brings, and what it is missing. This is the page's
  // actual argument — the feature grid further down is only the evidence.
  const wheel = [
    { t: L.wheelMenteeT, d: L.wheelMenteeD, arrow: L.wheelArrow1, icon: GraduationCap, c: 'bg-green-50 border-green-100 text-green-900', badge: 'bg-green-100 text-green-700' },
    { t: L.wheelMentorT, d: L.wheelMentorD, arrow: L.wheelArrow2, icon: Users, c: 'bg-blue-50 border-blue-100 text-blue-900', badge: 'bg-blue-100 text-blue-700' },
    { t: L.wheelCompanyT, d: L.wheelCompanyD, arrow: L.wheelArrow3, icon: Building2, c: 'bg-indigo-50 border-indigo-100 text-indigo-900', badge: 'bg-indigo-100 text-indigo-700' },
  ];

  const pick = [
    { t: L.pickMenteeT, d: L.pickMenteeD, cta: L.pickMenteeCta, href: '#mentee', icon: GraduationCap, c: 'hover:border-green-300', badge: 'bg-green-100 text-green-700' },
    { t: L.pickMentorT, d: L.pickMentorD, cta: L.pickMentorCta, href: '#mentor', icon: Users, c: 'hover:border-blue-300', badge: 'bg-blue-100 text-blue-700' },
    { t: L.pickCompanyT, d: L.pickCompanyD, cta: L.pickCompanyCta, href: '#company', icon: Building2, c: 'hover:border-indigo-300', badge: 'bg-indigo-100 text-indigo-700' },
  ];

  const menteeItems = [
    { t: L.audMentee1T, d: L.audMentee1D },
    { t: L.audMentee2T, d: L.audMentee2D },
    { t: L.audMentee3T, d: L.audMentee3D },
    { t: L.audMentee4T, d: L.audMentee4D },
    { t: L.audMentee5T, d: L.audMentee5D },
    { t: L.audMentee6T, d: L.audMentee6D },
  ];
  const mentorItems = [
    { t: L.audMentor1T, d: L.audMentor1D },
    { t: L.audMentor2T, d: L.audMentor2D },
    { t: L.audMentor3T, d: L.audMentor3D },
    { t: L.audMentor4T, d: L.audMentor4D },
    { t: L.audMentor5T, d: L.audMentor5D },
  ];
  const companyItems = [
    { t: L.audCompany1T, d: L.audCompany1D },
    { t: L.audCompany2T, d: L.audCompany2D },
    { t: L.audCompany3T, d: L.audCompany3D },
    { t: L.audCompany4T, d: L.audCompany4D },
    { t: L.audCompany5T, d: L.audCompany5D },
    { t: L.audCompany6T, d: L.audCompany6D },
  ];

  const how = [
    { t: L.how1T, d: L.how1D },
    { t: L.how2T, d: L.how2D },
    { t: L.how3T, d: L.how3D },
  ];

  // Only claims a stranger can check without an account. The version count is
  // read from the release notes rather than typed in, so it cannot go stale.
  const releaseCount = RELEASE_NOTES.length;
  const transparency = [
    { t: L.trans1T, d: L.trans1D, icon: Code2 },
    { t: L.trans2T.replace('{n}', String(releaseCount)), d: L.trans2D, icon: ScrollText },
    { t: L.trans4T, d: L.trans4D, icon: Languages },
    { t: L.trans5T, d: L.trans5D, icon: ShieldCheck },
  ];

  const faq = [
    {
      group: L.faqFilterMentee,
      items: [
        { q: L.faqMentee1Q, a: L.faqMentee1A }, { q: L.faqMentee2Q, a: L.faqMentee2A },
        { q: L.faqMentee3Q, a: L.faqMentee3A }, { q: L.faqMentee4Q, a: L.faqMentee4A },
        { q: L.faqMentee5Q, a: L.faqMentee5A }, { q: L.faqMentee6Q, a: L.faqMentee6A },
      ],
    },
    {
      group: L.faqFilterMentor,
      items: [
        { q: L.faqMentor1Q, a: L.faqMentor1A }, { q: L.faqMentor2Q, a: L.faqMentor2A },
        { q: L.faqMentor3Q, a: L.faqMentor3A }, { q: L.faqMentor4Q, a: L.faqMentor4A },
        { q: L.faqMentor5Q, a: L.faqMentor5A },
      ],
    },
    {
      group: L.faqFilterCompany,
      items: [
        { q: L.faqCompany1Q, a: L.faqCompany1A }, { q: L.faqCompany2Q, a: L.faqCompany2A },
        { q: L.faqCompany3Q, a: L.faqCompany3A }, { q: L.faqCompany4Q, a: L.faqCompany4A },
        { q: L.faqCompany5Q, a: L.faqCompany5A },
      ],
    },
  ];

  const roles = [
    { name: L.roleAdmin, desc: L.roleAdminD, c: 'bg-red-50 border-red-100 text-red-900', badge: 'bg-red-100 text-red-700' },
    { name: L.roleMentor, desc: L.roleMentorD, c: 'bg-blue-50 border-blue-100 text-blue-900', badge: 'bg-blue-100 text-blue-700' },
    { name: L.roleMentee, desc: L.roleMenteeD, c: 'bg-green-50 border-green-100 text-green-900', badge: 'bg-green-100 text-green-700' },
    { name: L.roleCompany, desc: L.roleCompanyD, c: 'bg-indigo-50 border-indigo-100 text-indigo-900', badge: 'bg-indigo-100 text-indigo-700' },
    { name: L.roleSource, desc: L.roleSourceD, c: 'bg-amber-50 border-amber-100 text-amber-900', badge: 'bg-amber-100 text-amber-700' },
  ];

  const more = [L.more1, L.more2, L.more3, L.more4, L.more5, L.more6, L.more7, L.more8];

  const stages = [L.stageApply, L.stageInterview, L.stageInternship, L.stageHired];

  // One audience block's benefit list: a claim, then how it is possible.
  const audienceList = (items: { t: string; d: string }[]) => (
    <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6 text-left">
      {items.map((it) => (
        <li key={it.t} className="flex items-start gap-3">
          <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-1" />
          <div>
            <h3 className="font-semibold text-gray-900 mb-1">{it.t}</h3>
            <p className="text-gray-600 text-sm leading-relaxed">{it.d}</p>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center gap-2 h-16">
            <div className="flex items-center gap-2 min-w-0">
              <GraduationCap className="h-7 w-7 sm:h-8 sm:w-8 text-blue-600 flex-shrink-0" />
              <span className="text-lg sm:text-xl font-bold text-gray-900 truncate">InternshipCRM</span>
              <BetaBadge className="flex-shrink-0" />
            </div>
            <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
              <Link href="/features" className="hidden sm:inline text-gray-600 hover:text-gray-900 font-medium transition-colors whitespace-nowrap text-sm sm:text-base">
                {t.featureCatalog.allFeatures}
              </Link>
              <Link href="/for-companies" className="hidden md:inline text-gray-600 hover:text-gray-900 font-medium transition-colors whitespace-nowrap text-sm sm:text-base">
                {t.forCompanies.nav}
              </Link>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                aria-label={L.transLinkGithub}
                className="hidden sm:inline-flex text-gray-600 hover:text-gray-900 transition-colors"
              >
                <Github className="h-5 w-5" />
              </a>
              <LanguageSwitcher current={locale} />
            <ThemeToggle />
              <Link href="/auth/signin" className="text-gray-600 hover:text-gray-900 font-medium transition-colors whitespace-nowrap text-sm sm:text-base">
                {L.signIn}
              </Link>
              <Link href="/auth/register" className="bg-blue-600 text-white px-3 sm:px-4 py-2 rounded-lg font-medium hover:bg-blue-700 transition-colors whitespace-nowrap text-sm sm:text-base">
                {L.register}
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero — states the loop rather than a slogan, and carries no button: the
          visitor picks a side two sections down. A single "get started" would
          funnel mentors and companies into the mentee sign-up form. */}
      <section className="py-20 sm:py-24 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-2 rounded-full text-sm font-medium mb-8">
            <CheckCircle className="h-4 w-4" />
            {L.badge}
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-6 leading-tight">
            {L.heroTitle} <span className="text-blue-600">{L.heroAccent}</span>
          </h1>
          <p className="text-lg sm:text-xl text-gray-600 mb-6 max-w-2xl mx-auto">{L.heroSubtitle}</p>
          <p className="text-base text-gray-700 font-medium max-w-2xl mx-auto">{L.heroModel}</p>
          <p className="mt-4 text-sm text-gray-500">
            {L.becomeMentor}{' '}
            <Link href="/apply-as-mentor" className="text-blue-600 hover:underline font-medium" data-testid="become-mentor-link">
              {L.becomeMentorLink}
            </Link>
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-2 sm:gap-3">
            {heroChips.map((chip) => (
              <span key={chip} className="inline-flex items-center gap-1.5 bg-white/70 border border-gray-200 text-gray-700 px-3 py-1.5 rounded-full text-xs sm:text-sm font-medium">
                <CheckCircle className="h-3.5 w-3.5 text-blue-600 flex-shrink-0" />
                {chip}
              </span>
            ))}
          </div>
          <div className="text-center mt-10">
            <a href="#loop" className="inline-flex items-center gap-1.5 text-blue-600 hover:underline font-medium">
              {L.heroScrollCue} <ArrowDown className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>

      {/* The loop */}
      <section id="loop" className="py-16 px-4 bg-white scroll-mt-16">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{L.wheelTitle}</h2>
            <p className="text-gray-600 mt-3 max-w-3xl mx-auto">{L.wheelSubtitle}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {wheel.map((w) => (
              <div key={w.t} className={`p-6 rounded-2xl border ${w.c}`}>
                <div className={`w-10 h-10 rounded-lg ${w.badge} flex items-center justify-center mb-4`}>
                  <w.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold mb-2">{w.t}</h3>
                <p className="text-sm opacity-80 leading-relaxed">{w.d}</p>
                <p className="mt-4 pt-3 border-t border-black/5 text-sm font-medium inline-flex items-center gap-1.5">
                  <ArrowRight className="h-4 w-4 flex-shrink-0" /> {w.arrow}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-10 max-w-3xl mx-auto bg-gray-50 border border-gray-200 rounded-2xl p-6 sm:p-8">
            <h3 className="font-semibold text-gray-900 mb-4">{L.wheelChainTitle}</h3>
            <ol className="space-y-2 text-gray-700 text-sm sm:text-base">
              {[L.wheelChain1, L.wheelChain2, L.wheelChain3].map((c, i) => (
                <li key={c} className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                  <span>{c}</span>
                </li>
              ))}
            </ol>
            <p className="text-sm text-gray-500 mt-5 italic">{L.wheelNote}</p>
          </div>
        </div>
      </section>

      {/* Pick your side */}
      <section className="py-16 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10">{L.pickTitle}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {pick.map((p) => (
              <a
                key={p.t}
                href={p.href}
                data-testid="role-card"
                className={`block p-6 rounded-2xl border border-gray-200 bg-white transition-all hover:shadow-lg ${p.c}`}
              >
                <div className={`w-10 h-10 rounded-lg ${p.badge} flex items-center justify-center mb-4`}>
                  <p.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold text-gray-900 mb-2">{p.t}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{p.d}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-blue-600 font-medium text-sm">
                  {p.cta} <ArrowRight className="h-4 w-4" />
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Mentee */}
      <section id="mentee" className="py-16 px-4 bg-white scroll-mt-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <span className="inline-block bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-semibold mb-4">{L.pickMenteeT}</span>
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{L.audMenteeTitle}</h2>
            <p className="text-gray-600 mt-3 max-w-3xl mx-auto">{L.audMenteeSubtitle}</p>
          </div>
          {audienceList(menteeItems)}
          <p className="mt-10 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-xl p-5 leading-relaxed">{L.audMenteeProof}</p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/auth/register" className="inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-7 py-3.5 rounded-xl font-semibold hover:bg-blue-700 transition-colors">
              {L.ctaMentee} <ArrowRight className="h-5 w-5" />
            </Link>
            <Link href="/projects" className="inline-flex items-center gap-1.5 text-blue-600 hover:underline font-medium">
              {L.audMenteeCta2} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <p className="mt-3 text-center text-xs text-gray-500 max-w-xl mx-auto">{L.audMenteeCtaNote}</p>
        </div>
      </section>

      {/* Mentor */}
      <section id="mentor" className="py-16 px-4 scroll-mt-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <span className="inline-block bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-semibold mb-4">{L.pickMentorT}</span>
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{L.audMentorTitle}</h2>
            <p className="text-gray-600 mt-3 max-w-3xl mx-auto">{L.audMentorSubtitle}</p>
          </div>
          {audienceList(mentorItems)}
          <p className="mt-8 text-sm text-gray-700 text-center">{L.audMentorTrust}</p>
          <p className="mt-6 text-sm text-gray-600 bg-white border border-gray-200 rounded-xl p-5 leading-relaxed">{L.audMentorProof}</p>
          <div className="mt-8 flex justify-center">
            <Link
              href={mentorHref}
              className="inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-7 py-3.5 rounded-xl font-semibold hover:bg-blue-700 transition-colors"
            >
              {L.audMentorCta} <ArrowRight className="h-5 w-5 flex-shrink-0" />
            </Link>
          </div>
          <p className="mt-3 text-center text-xs text-gray-500 max-w-xl mx-auto">{L.audMentorCtaNote}</p>
        </div>
      </section>

      {/* Company */}
      <section id="company" className="py-16 px-4 bg-white scroll-mt-16">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <span className="inline-block bg-indigo-100 text-indigo-700 px-3 py-1 rounded-full text-xs font-semibold mb-4">{L.pickCompanyT}</span>
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{L.audCompanyTitle}</h2>
            <p className="text-gray-600 mt-3 max-w-3xl mx-auto">{L.audCompanySubtitle}</p>
          </div>
          {audienceList(companyItems)}
          <ul className="mt-8 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-gray-600">
            <li className="inline-flex items-center gap-1.5"><Code2 className="h-4 w-4 text-gray-400" />{L.audCompanyProof1}</li>
            <li className="inline-flex items-center gap-1.5"><ScrollText className="h-4 w-4 text-gray-400" />{L.audCompanyProof2.replace('{n}', String(releaseCount))}</li>
          </ul>
          <div className="mt-8 flex justify-center">
            <Link
              href={companyHref}
              className="inline-flex items-center justify-center gap-2 bg-indigo-600 text-white px-7 py-3.5 rounded-xl font-semibold hover:bg-indigo-700 transition-colors"
            >
              {L.audCompanyCta} <ArrowRight className="h-5 w-5 flex-shrink-0" />
            </Link>
          </div>
          <p className="mt-3 text-center text-xs text-gray-500 max-w-xl mx-auto">{L.audCompanyCtaNote}</p>
        </div>
      </section>

      {/* How it works */}
      <section className="py-16 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10">{L.howTitle}</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {how.map((h, i) => (
              <div key={h.t} className="p-6 rounded-2xl border border-gray-200 bg-white">
                <span className="w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center mb-4">{i + 1}</span>
                <h3 className="font-semibold text-gray-900 mb-2">{h.t}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{h.d}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-gray-500 max-w-3xl mx-auto text-center leading-relaxed">{L.howInterest}</p>
        </div>
      </section>

      {/* Pipeline diagram */}
      <section className="py-16 px-4 bg-white">
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
                    <text x={x + 58} y={85} className="fill-slate-800 dark:fill-slate-100" fontSize="15" fontWeight="600">{label}</text>
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
          <p className="text-sm text-gray-600 mt-6 max-w-2xl mx-auto">{L.pipelineStagesNote}</p>
          <p className="text-sm text-gray-500 mt-3 max-w-xl mx-auto italic">{L.pipelineNote}</p>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{L.featuresTitle}</h2>
            <p className="text-gray-600 mt-2">{L.featuresSubtitle}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="p-7 rounded-2xl border border-gray-100 bg-white hover:border-blue-200 hover:shadow-lg transition-all">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${iconBg[f.color]}`}>
                  <f.icon className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">{f.title}</h3>
                <p className="text-gray-600 text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link href="/features" className="inline-flex items-center gap-1.5 text-blue-600 hover:underline font-medium" data-testid="all-features-link">
              {t.featureCatalog.allFeatures} <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Roles */}
      <section className="py-16 px-4 bg-white">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10">{L.rolesTitle}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
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

      {/* And a lot more */}
      <section className="py-16 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">{L.moreTitle}</h2>
            <p className="text-gray-600 mt-2">{L.moreSubtitle}</p>
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
            {more.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                <span className="text-gray-700 text-sm sm:text-base leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Transparency */}
      <section className="py-16 px-4 bg-white">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10">{L.transTitle}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {transparency.map((tr) => (
              <div key={tr.t} className="flex items-start gap-4 p-6 rounded-xl border border-gray-200">
                <tr.icon className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-semibold text-gray-900 mb-1">{tr.t}</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{tr.d}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-sm text-gray-600 bg-amber-50 border border-amber-100 rounded-xl p-5 leading-relaxed">{L.transBeta}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
            <Link href="/features" className="text-blue-600 hover:underline">{L.transLinkFeatures}</Link>
            <Link href="/release-notes" className="text-blue-600 hover:underline">{L.transLinkReleases}</Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1.5">
              <Github className="h-4 w-4" />{L.transLinkGithub}
            </a>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-bold text-center text-gray-900 mb-10">{L.faqTitle}</h2>
          <div className="space-y-8">
            {faq.map((g) => (
              <div key={g.group}>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">{g.group}</h3>
                <div className="space-y-3">
                  {g.items.map((item) => (
                    <details key={item.q} className="group bg-white border border-gray-200 rounded-xl p-4">
                      <summary className="font-medium text-gray-900 cursor-pointer list-none flex items-start justify-between gap-3">
                        <span>{item.q}</span>
                        <ArrowDown className="h-4 w-4 text-gray-400 flex-shrink-0 mt-1 transition-transform group-open:rotate-180" />
                      </summary>
                      <p className="mt-3 text-sm text-gray-600 leading-relaxed">{item.a}</p>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA — one button per audience, all at the same weight */}
      <section className="py-16 px-4">
        <div className="max-w-4xl mx-auto text-center bg-gradient-to-r from-blue-600 to-indigo-600 rounded-3xl p-10 sm:p-14">
          <h2 className="text-2xl sm:text-3xl font-bold text-white mb-3">{L.ctaTitle}</h2>
          <p className="text-blue-100 mb-8">{L.ctaSubtitle}</p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/auth/register" className="inline-flex items-center justify-center gap-2 bg-white text-blue-700 px-7 py-3.5 rounded-xl font-semibold hover:bg-blue-50 transition-colors dark:!bg-white dark:!text-blue-700 dark:hover:!bg-blue-100">
              {L.ctaMentee} <ArrowRight className="h-5 w-5" />
            </Link>
            <Link
              href={mentorHref}
              className="inline-flex items-center justify-center gap-2 border-2 border-white/60 text-white px-7 py-3.5 rounded-xl font-semibold hover:bg-white/10 transition-colors"
            >
              <Users className="h-5 w-5" /> {L.ctaMentor}
            </Link>
            <Link
              href={companyHref}
              className="inline-flex items-center justify-center gap-2 border-2 border-white/60 text-white px-7 py-3.5 rounded-xl font-semibold hover:bg-white/10 transition-colors"
            >
              <Briefcase className="h-5 w-5" /> {L.ctaCompany}
            </Link>
          </div>
          <p className="mt-6 text-sm text-blue-100">
            {t.auth.wantMentor}{' '}
            <Link href="/apply-as-mentor" className="text-white underline hover:text-blue-50 font-medium" data-testid="apply-as-mentor-link">
              {t.auth.applyMentorLink}
            </Link>
          </p>
          <p className="mt-2 text-xs text-blue-100">{L.ctaFootnote}</p>
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
          <div className="flex items-center gap-4">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-gray-700">GitHub</a>
            <Link href="/features" className="hover:text-gray-700">{t.featureCatalog.allFeatures}</Link>
            <Link href="/privacy" className="hover:text-gray-700">{t.privacy.title}</Link>
            <Link href="/terms" className="hover:text-gray-700">{t.terms.title}</Link>
            <Link href="/code-of-conduct" className="hover:text-gray-700">{t.codeOfConduct.title}</Link>
            <VersionFooter version={APP_VERSION} />
          </div>
        </div>
      </footer>
    </div>
  );
}
