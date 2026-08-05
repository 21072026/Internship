import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { OnboardingForm } from '@/components/forms/OnboardingForm';
import { MentorOnboardingForm } from '@/components/forms/MentorOnboardingForm';
import { getServerDictionary } from '@/i18n/server';

export default async function OnboardingPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role !== 'MENTEE' && session.user.role !== 'MENTOR') {
    redirect('/');
  }
  const { t } = await getServerDictionary();
  const isMentor = session.user.role === 'MENTOR';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{isMentor ? t.mentorOnboarding.title : t.portal.completeProfile}</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-2">{isMentor ? t.mentorOnboarding.subtitle : t.portal.completeProfileHint}</p>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          {isMentor ? <MentorOnboardingForm /> : <OnboardingForm />}
        </div>
      </div>
    </div>
  );
}
