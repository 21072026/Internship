import { notFound } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { getPublicEvaluationSummary } from '@/lib/testimonials';
import { getServerDictionary } from '@/i18n/server';
import { ProfileViewPing } from '@/components/ProfileViewPing';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ThemeToggle } from '@/components/ThemeToggle';
import { PublicContactForm } from '@/components/PublicContactForm';

// Public, PII-free profile. Only fields safe to share are selected — never
// email, phone, whatsapp, or birth date.
export default async function PublicProfilePage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const { locale, t } = await getServerDictionary();

  const user = await prisma.user.findFirst({
    where: { id: userId, publicProfile: true, role: { in: ['MENTEE', 'MENTOR'] } },
    select: {
      fullName: true,
      role: true,
      university: true,
      department: true,
      graduationYear: true,
      city: true,
      skills: true,
      avatarUrl: true,
      displayName: true,
      bio: true,
      country: true,
      targetPosition: true,
      linkedinUrl: true,
      githubUrl: true,
      portfolioUrl: true,
      interests: true,
      languages: true,
      mentorCapacity: true,
      publicShowProjects: true,
      _count: {
        select: {
          mentorRelations: { where: { status: 'ACTIVE' } },
        },
      },
    },
  });

  if (!user) notFound();

  // Project showcase (#1091): the user's own work in PUBLIC projects only —
  // a private project must never leak even its name, so both queries carry
  // the isPublic filter. Task TITLES are project-internal and never shown,
  // only the completed count. The whole section is skippable per user.
  const [memberships, doneTasks] = user.publicShowProjects
    ? await Promise.all([
        prisma.projectMember.findMany({
          where: { userId, project: { isPublic: true } },
          select: {
            functionalRole: true,
            project: { select: { id: true, name: true, technologies: true, status: true } },
          },
        }),
        prisma.projectTask.count({
          where: { assigneeId: userId, done: true, project: { isPublic: true } },
        }),
      ])
    : [[], 0];

  // Consent-gated mentor evaluation summary (#1094) — every gate enforced
  // server-side in the lib; null means the section does not exist at all.
  const evaluationSummary = user.role === 'MENTEE' ? await getPublicEvaluationSummary(userId) : null;

  const skills = Array.isArray(user.skills) ? (user.skills as string[]) : [];
  const languages = Array.isArray(user.languages) ? (user.languages as string[]) : [];
  const isMentor = user.role === 'MENTOR';
  const headline = user.displayName || user.fullName;
  const location = [user.city, user.country].filter(Boolean).join(', ');
  const links = [
    { label: 'LinkedIn', url: user.linkedinUrl },
    { label: 'GitHub', url: user.githubUrl },
    { label: t.publicProfile.portfolio, url: user.portfolioUrl },
  ].filter((l) => l.url);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <ProfileViewPing userId={userId} />
      <div className="w-full max-w-lg">
        {/* Public controls: language, theme, and a link back to the product. */}
        <div className="mb-3 flex items-center justify-between gap-2">
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700">
            <GraduationCap className="h-4 w-4" /> InternshipCRM
          </Link>
          <div className="flex items-center gap-2">
            <LanguageSwitcher current={locale} />
            <ThemeToggle />
          </div>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="flex items-center gap-4 mb-6">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt={user.fullName} className="w-16 h-16 rounded-2xl object-cover border border-gray-200" />
            ) : (
              <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center">
                <span className="text-blue-700 font-bold text-2xl">{user.fullName?.[0] ?? '?'}</span>
              </div>
            )}
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{headline}</h1>
              {isMentor ? (
                <p className="text-blue-600 text-sm font-medium">{t.publicProfile.mentor}</p>
              ) : (
                user.targetPosition && <p className="text-blue-600 text-sm font-medium">{user.targetPosition}</p>
              )}
              {location && <p className="text-gray-500">{location}</p>}
            </div>
          </div>

          {user.bio && <p className="text-sm text-gray-700 mb-6 whitespace-pre-line">{user.bio}</p>}

          <dl className="space-y-3 text-sm">
            {!isMentor && user.university && (
              <div>
                <dt className="text-gray-500">{t.publicProfile.university}</dt>
                <dd className="text-gray-900">{user.university}</dd>
              </div>
            )}
            {!isMentor && user.department && (
              <div>
                <dt className="text-gray-500">{t.publicProfile.department}</dt>
                <dd className="text-gray-900">{user.department}</dd>
              </div>
            )}
            {!isMentor && user.graduationYear && (
              <div>
                <dt className="text-gray-500">{t.publicProfile.graduationYear}</dt>
                <dd className="text-gray-900">{user.graduationYear}</dd>
              </div>
            )}
            {skills.length > 0 && (
              <div>
                <dt className="text-gray-500 mb-1">{t.publicProfile.skills}</dt>
                <dd className="flex flex-wrap gap-1">
                  {skills.map((s) => (
                    <span key={s} className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 text-xs">
                      {s}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {isMentor && user.interests && (
              <div>
                <dt className="text-gray-500">{t.publicProfile.expertise}</dt>
                <dd className="text-gray-900 whitespace-pre-line">{user.interests}</dd>
              </div>
            )}
            {isMentor && languages.length > 0 && (
              <div>
                <dt className="text-gray-500 mb-1">{t.publicProfile.languages}</dt>
                <dd className="flex flex-wrap gap-1">
                  {languages.map((language) => (
                    <span key={language} className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs">
                      {language}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {isMentor && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="text-gray-500">{t.publicProfile.activeMentees}</dt>
                  <dd className="text-gray-900" data-testid="public-profile-active-mentees">{user._count.mentorRelations}</dd>
                </div>
                {user.mentorCapacity != null && (
                  <div>
                    <dt className="text-gray-500">{t.publicProfile.capacity}</dt>
                    <dd className="text-gray-900" data-testid="public-profile-capacity">{user.mentorCapacity}</dd>
                  </div>
                )}
              </div>
            )}
          </dl>

          {/* Evaluation summary (#1094): derived average + one approved
              excerpt. Rendered only when every consent/publish gate held —
              otherwise not even an empty box. */}
          {evaluationSummary && (evaluationSummary.average !== null || evaluationSummary.excerpt) && (
            <div className="mt-6 pt-4 border-t border-gray-100" data-testid="public-evaluation-summary">
              <h2 className="text-sm font-semibold text-gray-900 mb-2">{t.publicProfile.evaluationTitle}</h2>
              {evaluationSummary.average !== null && (
                <p className="text-sm text-gray-700" data-testid="public-evaluation-average">
                  <span className="font-semibold text-blue-700">{evaluationSummary.average}</span>
                  <span className="text-gray-400">/5</span>{' '}
                  <span className="text-gray-500">
                    {t.publicProfile.evaluationCount.replace('{n}', String(evaluationSummary.count))}
                  </span>
                </p>
              )}
              {evaluationSummary.excerpt && (
                <figure className="mt-2 rounded-xl bg-blue-50 p-4">
                  <blockquote className="text-sm text-gray-700 italic leading-relaxed">
                    “{evaluationSummary.excerpt}”
                  </blockquote>
                  {evaluationSummary.mentorName && (
                    <figcaption className="mt-2 text-xs text-gray-500">
                      — {evaluationSummary.mentorName}, {t.publicProfile.evaluationByMentor}
                    </figcaption>
                  )}
                </figure>
              )}
            </div>
          )}

          {/* Project showcase (#1091): public projects only; hidden entirely
              when there is nothing to show — "0 projects" is worse than
              nothing. */}
          {memberships.length > 0 && (
            <div className="mt-6 pt-4 border-t border-gray-100" data-testid="public-projects">
              <h2 className="text-sm font-semibold text-gray-900 mb-2">{t.publicProfile.projectsTitle}</h2>
              <ul className="space-y-2">
                {memberships.map((m) => (
                  <li key={m.project.id} className="rounded-xl bg-gray-50 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{m.project.name}</span>
                      {m.functionalRole && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] text-blue-700">
                          {t.publicProfile.functionalRoles[m.functionalRole]}
                        </span>
                      )}
                    </div>
                    {Array.isArray(m.project.technologies) && (m.project.technologies as string[]).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {(m.project.technologies as string[]).slice(0, 8).map((tech) => (
                          <span key={tech} className="rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-600 border border-gray-200">
                            {tech}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {doneTasks > 0 && (
                <p className="mt-2 text-xs text-gray-500" data-testid="public-projects-tasks">
                  {t.publicProfile.tasksCompleted.replace('{n}', String(doneTasks))}
                </p>
              )}
            </div>
          )}

          {links.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {links.map((l) => (
                <a
                  key={l.label}
                  href={l.url!}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-medium hover:bg-gray-200 transition-colors"
                >
                  {l.label}
                </a>
              ))}
            </div>
          )}

          <PublicContactForm userId={userId} />

          <Link
            href="/"
            className="mt-8 pt-4 border-t border-gray-100 flex items-center gap-2 text-xs text-gray-400 hover:text-blue-600 transition-colors"
          >
            <GraduationCap className="h-4 w-4" />
            {t.publicProfile.poweredBy}
          </Link>
        </div>
      </div>
    </div>
  );
}
