import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { getMentorMenteeActivity } from '@/lib/activityReport';
import { ActivityReportView } from '@/components/ActivityReportView';

const ALLOWED_DAYS = [1, 7, 30];

export default async function MentorActivityPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  const { locale, t } = await getServerDictionary();

  const sp = await searchParams;
  const days = ALLOWED_DAYS.includes(Number(sp.days)) ? Number(sp.days) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const items = await getMentorMenteeActivity(session.user.id, since);

  return (
    <ActivityReportView
      items={items}
      days={days}
      basePath="/mentor/mentee-activity"
      subtitle={t.activityReport.mentorSubtitle}
      t={t}
      locale={locale}
    />
  );
}
