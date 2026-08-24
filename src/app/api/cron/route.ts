import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import {
  checkMentorInteractionReminders,
  sendMeetingReminders,
  sendProjectMeetingSeriesReminders,
  sendWeeklyMentorDigests,
  checkStageDeadlineReminders,
  checkRetentionReminders,
  checkCompanyNeedMatches,
  sendWeeklyAnalyticsReport,
  sendWeeklyReportReminders,
  sendWeeklyMissingDocumentReminders,
  runEmailHealthCheck,
  checkReEngagementReminders,
} from '@/services/emailService';
import { expireOffers } from '@/lib/offerNotify';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const job = new URL(request.url).searchParams.get('job');
    if (job === 'weekly-reports') {
      return NextResponse.json({ message: 'Weekly report reminders ran', weeklyReports: await sendWeeklyReportReminders() });
    }
    if (job === 'email-health') {
      return NextResponse.json({ message: 'Email health check ran', email: await runEmailHealthCheck() });
    }
    // Stage service levels (#817): runnable on its own so the idempotency of
    // the overdue reminder can be exercised — and so an admin can re-run just
    // this one after fixing an SMTP problem.
    if (job === 'stage-deadlines') {
      return NextResponse.json({ message: 'Stage deadline reminders ran', deadlines: await checkStageDeadlineReminders() });
    }
    if (job === 're-engagement') {
      return NextResponse.json({ message: 'Re-engagement reminders ran', reEngagement: await checkReEngagementReminders() });
    }
    if (job === 'missing-documents') {
      const missingDocuments = await sendWeeklyMissingDocumentReminders();
      return NextResponse.json({ message: 'Missing-document reminders ran', missingDocuments });
    }

    const [interactions, meetings, projectMeetings, digests, deadlines, retention, needMatches, analyticsReport, missingDocuments, offers, weeklyReports, reEngagement] = await Promise.all([
      checkMentorInteractionReminders(),
      sendMeetingReminders(),
      sendProjectMeetingSeriesReminders(),
      sendWeeklyMentorDigests(),
      checkStageDeadlineReminders(),
      checkRetentionReminders(),
      checkCompanyNeedMatches(),
      sendWeeklyAnalyticsReport(),
      sendWeeklyMissingDocumentReminders(),
      expireOffers(),
      sendWeeklyReportReminders(),
      checkReEngagementReminders(),
    ]);

    return NextResponse.json({
      message: 'Scheduled jobs ran',
      interactions,
      meetings,
      projectMeetings,
      digests,
      deadlines,
      retention,
      needMatches,
      analyticsReport,
      missingDocuments,
      offers,
      weeklyReports,
      reEngagement,
    });
  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
