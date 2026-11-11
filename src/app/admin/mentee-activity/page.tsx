import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getServerDictionary } from '@/i18n/server';
import { getSystemMenteeActivity } from '@/lib/activityReport';
import { programGrantsFor } from '@/lib/authzScope';
import { programRelationWhere } from '@/lib/programScopeRule';
import type { Prisma } from '@prisma/client';
import { tenantWhere } from '@/lib/tenantFilter';
import { ActivityReportView } from '@/components/ActivityReportView';

const ALLOWED_DAYS = [1, 7, 30];

export default async function AdminMenteeActivityPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  const { locale, t } = await getServerDictionary();

  const sp = await searchParams;
  const days = ALLOWED_DAYS.includes(Number(sp.days)) ? Number(sp.days) : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // The admin's own tenant only (#2542) — never every org's mentees.
  // A PROGRAM_ADMIN reads its own programmes' mentees only (#1577).
  const grants = await programGrantsFor(session.user);
  const items = await getSystemMenteeActivity(
    since,
    await tenantWhere(session),
    (grants ? programRelationWhere(grants) : {}) as Prisma.MentorshipRelationWhereInput,
  );

  return (
    <ActivityReportView
      items={items}
      days={days}
      basePath="/admin/mentee-activity"
      subtitle={t.activityReport.adminSubtitle}
      t={t}
      locale={locale}
    />
  );
}
