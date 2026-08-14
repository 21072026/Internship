import { getServerSession } from 'next-auth';
import { notFound, redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { WeeklyReportPrintButton } from '@/components/WeeklyReportPrintButton';
import { addUtcWeeks } from '@/lib/week';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';

export default async function WeeklyReportPrintPage({ searchParams }: { searchParams: Promise<{ relationId?: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  const relationId = (await searchParams).relationId || '';
  const result = await withTenantScope(session, async () => {
    const role = session.user.role;
    const orgId = resolveOrgId(session);
    if (!['MENTEE', 'MENTOR', 'ADMIN'].includes(role) || (role === 'ADMIN' && !orgId)) return null;
    const relation = await prisma.mentorshipRelation.findFirst({
      where: {
        id: relationId,
        ...(role === 'MENTEE' ? { menteeId: session.user.id } : {}),
        ...(role === 'MENTOR' ? { mentorId: session.user.id } : {}),
        ...(role === 'ADMIN' ? { orgId: orgId! } : {}),
      },
      select: { id: true },
    });
    if (!relation) return null;
    const reports = await prisma.weeklyReport.findMany({
      where: { relationId: relation.id, ...(role === 'ADMIN' ? { orgId: orgId! } : {}) },
      orderBy: { weekStart: 'asc' },
    });
    return { reports };
  });
  if (!result) notFound();
  const { reports } = result;
  const { t, locale } = await getServerDictionary();
  const date = (value: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(value);

  return (
    <main className="mx-auto max-w-3xl p-6 print:max-w-none print:p-0">
      <div className="no-print mb-6 flex justify-end"><WeeklyReportPrintButton label={t.weeklyReports.printDiary} /></div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">{t.weeklyReports.printDiary}</h1>
      {reports.length === 0 && <p>{t.weeklyReports.noReports}</p>}
      <div className="space-y-6">
        {reports.map((report) => <article key={report.id} className="break-inside-avoid border-b border-gray-300 pb-5">
          <h2 className="font-semibold">{t.weeklyReports.weekRange.replace('{start}', date(report.weekStart)).replace('{end}', date(new Date(addUtcWeeks(report.weekStart, 1).getTime() - 1)))}</h2>
          <p className="mt-1 text-sm">{t.weeklyReports.statusLabel}: {t.weeklyReports.status[report.status]}</p>
          <p className="mt-2 whitespace-pre-wrap">{report.summary}</p>
          {report.hoursSpent !== null && <p className="mt-2 text-sm">{t.weeklyReports.hours}: {report.hoursSpent}</p>}
          {report.blockers && <p className="mt-2 whitespace-pre-wrap text-sm"><strong>{t.weeklyReports.blockers}:</strong> {report.blockers}</p>}
          {report.mentorComment && <p className="mt-2 whitespace-pre-wrap text-sm"><strong>{t.weeklyReports.mentorComment}:</strong> {report.mentorComment}</p>}
        </article>)}
      </div>
    </main>
  );
}
