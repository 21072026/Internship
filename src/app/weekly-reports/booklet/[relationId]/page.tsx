import { getServerSession } from 'next-auth';
import { notFound, redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { WeeklyReportPrintButton } from '@/components/WeeklyReportPrintButton';
import { withTenantScope } from '@/lib/orgContext';
import { inCallerTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { canReadWeeklyReports } from '@/lib/weeklyReports';
import { addUtcWeeks } from '@/lib/week';
import { complianceForRelation, expectedWeeks, internshipWindow, weekByWeek } from '@/lib/weeklyReportCompliance';
import { COMPLIANCE_RELATION_SELECT, INTERNED_WHERE } from '@/lib/weeklyReportComplianceQuery';

// The accreditation booklet (#1918): one intern's whole internship as a single
// printable document — a cover page (intern, company, mentor, cohort, period,
// total hours, owed vs handed-in weeks, two signature lines), then every owed
// week in order with what was written and what the mentor said.
//
// A PAGE TO PRINT, not a file download: the browser's print-to-PDF is what a
// coordinator uses anyway, it needs no PDF library, and a sandboxed viewer that
// blocks script-driven downloads still prints. It sits outside the admin shell
// (like /weekly-reports/print) so nothing but the booklet reaches the paper.
//
// Admin-only and read-only. The weeks and their states are the compliance
// rule's (src/lib/weeklyReportCompliance.ts) — the booklet cannot disagree
// with the screen it is opened from.

export default async function WeeklyReportBookletPage({ params }: { params: Promise<{ relationId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'ADMIN') notFound();
  if (!(await shellCapabilities(session.user.orgId)).includes('mentorship')) notFound();
  const { relationId } = await params;

  const data = await withTenantScope(session, async () => {
    const relation = await prisma.mentorshipRelation.findFirst({
      where: { AND: [{ id: relationId }, INTERNED_WHERE] },
      select: { ...COMPLIANCE_RELATION_SELECT, orgId: true, mentorId: true, menteeId: true },
    });
    if (!relation || !(await inCallerTenant(relation.orgId, session.user.orgId))) return null;
    if (!canReadWeeklyReports(session.user, relation)) return null;
    const [changes, reports] = await Promise.all([
      prisma.statusChange.findMany({ where: { relationId }, select: { fromStatus: true, toStatus: true, createdAt: true } }),
      prisma.weeklyReport.findMany({
        where: { relationId },
        orderBy: { weekStart: 'asc' },
        select: {
          id: true, weekStart: true, status: true, submittedAt: true, summary: true, hoursSpent: true, blockers: true,
          mentorComment: true, reviewedAt: true, reviewedBy: { select: { fullName: true } },
        },
      }),
    ]);
    return { relation, changes, reports };
  });
  if (!data) notFound();

  const { relation, changes, reports } = data;
  const window = internshipWindow({ ...relation, changes });
  const expected = expectedWeeks(window, new Date());
  const weeks = weekByWeek(expected, reports);
  const compliance = complianceForRelation({ expected, reports });
  const totalHours = weeks.reduce((sum, w) => sum + (w.report && w.state !== 'draft' ? w.report.hoursSpent ?? 0 : 0), 0);

  const { t, locale } = await getServerDictionary();
  const T = t.adminWeeklyReports;
  const date = (value: Date) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(value);
  const stateLabel = {
    approved: T.stateApproved, submitted: T.stateSubmitted, changes_requested: T.stateChanges, draft: T.stateDraft, missing: T.stateMissing,
  } as const;
  const cover: [string, string][] = [
    [T.intern, relation.mentee.fullName],
    [T.company, relation.company?.name ?? T.none],
    [T.mentor, relation.mentor.fullName],
    [T.bookletCohort, relation.cohort?.name ?? T.none],
    [T.bookletPeriod, window ? `${date(window.start)} – ${window.end ? date(window.end) : T.ongoing}` : T.none],
    [T.bookletTotalHours, String(totalHours)],
    [T.bookletWeeksOwed, String(compliance.expected)],
    [T.bookletWeeksSubmitted, String(compliance.submitted)],
  ];

  return (
    <main className="mx-auto max-w-3xl bg-white p-6 text-gray-900 print:max-w-none print:p-0" data-testid="weekly-report-booklet">
      <style>{'@media print { @page { size: A4; margin: 18mm; } .booklet-cover { break-after: page; } }'}</style>
      <div className="no-print mb-6 flex justify-end"><WeeklyReportPrintButton label={T.bookletPrint} /></div>

      <section className="booklet-cover mb-10">
        <h1 className="text-3xl font-bold">{T.bookletTitle}</h1>
        <p className="mt-2 text-lg">{relation.mentee.fullName}</p>
        <dl className="mt-8 grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 print:grid-cols-2">
          {cover.map(([label, value]) => (
            <div key={label} className="border-b border-gray-200 pb-2">
              <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
              <dd className="mt-0.5 font-medium" data-testid={`booklet-${label}`}>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-16 grid grid-cols-2 gap-10">
          {[T.bookletSignatureIntern, T.bookletSignatureMentor].map((label) => (
            <div key={label}>
              <div className="h-12 border-b border-gray-500" />
              <p className="mt-1 text-xs text-gray-600">{label}</p>
            </div>
          ))}
        </div>
        <p className="mt-10 text-xs text-gray-500">{T.bookletGenerated.replace('{date}', date(new Date()))}</p>
      </section>

      {weeks.length === 0 && <p>{T.noWeeks}</p>}
      <div className="space-y-6">
        {weeks.map((w) => {
          const handedIn = w.report && w.state !== 'draft' ? w.report : null;
          return (
            <article key={w.weekStart.toISOString()} className="break-inside-avoid border-b border-gray-300 pb-5" data-testid="booklet-week">
              <h2 className="font-semibold">
                {t.weeklyReports.weekRange.replace('{start}', date(w.weekStart)).replace('{end}', date(new Date(addUtcWeeks(w.weekStart, 1).getTime() - 1)))}
              </h2>
              <p className="mt-1 text-sm text-gray-700">
                {T.colState}: {stateLabel[w.state]}{w.late ? ` · ${T.stateLate}` : ''}
              </p>
              {handedIn ? (
                <>
                  <p className="mt-2 whitespace-pre-wrap">{handedIn.summary}</p>
                  {handedIn.hoursSpent !== null && <p className="mt-2 text-sm">{T.hours}: {handedIn.hoursSpent}</p>}
                  {handedIn.blockers && <p className="mt-2 whitespace-pre-wrap text-sm"><strong>{T.blockers}:</strong> {handedIn.blockers}</p>}
                  {handedIn.mentorComment && <p className="mt-2 whitespace-pre-wrap text-sm"><strong>{T.mentorComment}:</strong> {handedIn.mentorComment}</p>}
                  {handedIn.reviewedAt && handedIn.reviewedBy && (
                    <p className="mt-2 text-xs text-gray-500">
                      {T.bookletReviewed.replace('{name}', handedIn.reviewedBy.fullName).replace('{date}', date(handedIn.reviewedAt))}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm italic text-gray-600">{T.notHandedIn}</p>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}
