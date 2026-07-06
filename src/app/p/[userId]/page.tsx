import { notFound } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap } from 'lucide-react';
import { prisma } from '@/lib/prisma';
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
    where: { id: userId, publicProfile: true },
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
    },
  });

  if (!user) notFound();

  const skills = Array.isArray(user.skills) ? (user.skills as string[]) : [];
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
              {user.targetPosition && <p className="text-blue-600 text-sm font-medium">{user.targetPosition}</p>}
              {location && <p className="text-gray-500">{location}</p>}
            </div>
          </div>

          {user.bio && <p className="text-sm text-gray-700 mb-6 whitespace-pre-line">{user.bio}</p>}

          <dl className="space-y-3 text-sm">
            {user.university && (
              <div>
                <dt className="text-gray-500">{t.publicProfile.university}</dt>
                <dd className="text-gray-900">{user.university}</dd>
              </div>
            )}
            {user.department && (
              <div>
                <dt className="text-gray-500">{t.publicProfile.department}</dt>
                <dd className="text-gray-900">{user.department}</dd>
              </div>
            )}
            {user.graduationYear && (
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
          </dl>

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
