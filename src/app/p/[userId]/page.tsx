import { notFound } from 'next/navigation';
import { GraduationCap } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { ProfileViewPing } from '@/components/ProfileViewPing';

// Public, PII-free profile. Only fields safe to share are selected — never
// email, phone, whatsapp, or birth date.
export default async function PublicProfilePage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const { t } = await getServerDictionary();

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
    },
  });

  if (!user) notFound();

  const skills = Array.isArray(user.skills) ? (user.skills as string[]) : [];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <ProfileViewPing userId={userId} />
      <div className="w-full max-w-lg">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="flex items-center gap-4 mb-6">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.avatarUrl} alt="" className="w-16 h-16 rounded-2xl object-cover border border-gray-200" />
            ) : (
              <div className="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center">
                <span className="text-blue-700 font-bold text-2xl">{user.fullName?.[0] ?? '?'}</span>
              </div>
            )}
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{user.fullName}</h1>
              {user.city && <p className="text-gray-500">{user.city}</p>}
            </div>
          </div>

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

          <div className="mt-8 pt-4 border-t border-gray-100 flex items-center gap-2 text-xs text-gray-400">
            <GraduationCap className="h-4 w-4" />
            {t.publicProfile.poweredBy}
          </div>
        </div>
      </div>
    </div>
  );
}
