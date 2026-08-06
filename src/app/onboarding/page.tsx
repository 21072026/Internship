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

  if (session.user.role === 'MENTOR') {
    const { t } = await getServerDictionary();
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
        <div className="w-full max-w-lg">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-gray-900">{t.onboarding.mentor.title}</h1>
            <p className="text-gray-500 mt-2">{t.onboarding.mentor.subtitle}</p>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
            <MentorOnboardingForm />
          </div>
        </div>
      </div>
    );
  }

  if (session.user.role !== 'MENTEE') {
    redirect('/');
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Complete Your Profile</h1>
          <p className="text-gray-500 mt-2">
            Help us match you with the right mentor and opportunities
          </p>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <OnboardingForm />
        </div>
      </div>
    </div>
  );
}
