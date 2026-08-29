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
  sendDormantCheckIns,
} from '@/services/emailService';
import { expireOffers } from '@/lib/offerNotify';
import { sweepMeetingInteractionLogs } from '@/lib/meetingAutoLog';
import { dispatchDueNewsletters, queueScheduledNewsletter } from '@/lib/newsletterDispatch';
import { sweepDormantFirstContacts } from '@/lib/dormantFirstContact';

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
    // Meeting auto-logs (#1489), runnable on its own: after a deploy an admin
    // wants the backlog of already-held meetings logged now, not one batch per
    // quarter-hourly tick.
    if (job === 'meeting-logs') {
      return NextResponse.json({ message: 'Meeting interaction logs ran', meetingLogs: await sweepMeetingInteractionLogs() });
    }
    if (job === 're-engagement') {
      return NextResponse.json({ message: 'Re-engagement reminders ran', reEngagement: await checkReEngagementReminders() });
    }
    // Newsletter (#1469), runnable on its own: dispatching a due issue and
    // deciding whether the cadence should queue the next one are separate
    // decisions, and an admin who just fixed SMTP wants only the first.
    if (job === 'newsletters') {
      return NextResponse.json({ message: 'Newsletter dispatch ran', newsletters: await dispatchDueNewsletters() });
    }
    if (job === 'newsletter-queue') {
      return NextResponse.json({ message: 'Newsletter queue ran', newsletterQueue: await queueScheduledNewsletter() });
    }
    // Dormant first contacts (#1508), runnable on its own: the sweep and the
    // check-in are one decision, so the job runs both and reports both.
    if (job === 'dormant') {
      const dormantSweep = await sweepDormantFirstContacts();
      return NextResponse.json({ message: 'Dormant first contacts ran', dormantSweep, dormantCheckIns: await sendDormantCheckIns() });
    }
    if (job === 'missing-documents') {
      const missingDocuments = await sendWeeklyMissingDocumentReminders();
      return NextResponse.json({ message: 'Missing-document reminders ran', missingDocuments });
    }

    // Sequenced ahead of the batch below rather than inside it: the sweep is
    // what decides who counts as dormant today, and the mails it drives must
    // read the state it just wrote, not race it.
    const dormantSweep = await sweepDormantFirstContacts();
    const dormantCheckIns = await sendDormantCheckIns();

    const [interactions, meetings, projectMeetings, meetingLogs, digests, deadlines, retention, needMatches, analyticsReport, missingDocuments, offers, weeklyReports, reEngagement, newsletters] = await Promise.all([
      checkMentorInteractionReminders(),
      sendMeetingReminders(),
      sendProjectMeetingSeriesReminders(),
      sweepMeetingInteractionLogs(),
      sendWeeklyMentorDigests(),
      checkStageDeadlineReminders(),
      checkRetentionReminders(),
      checkCompanyNeedMatches(),
      sendWeeklyAnalyticsReport(),
      sendWeeklyMissingDocumentReminders(),
      expireOffers(),
      sendWeeklyReportReminders(),
      checkReEngagementReminders(),
      dispatchDueNewsletters(),
    ]);

    return NextResponse.json({
      message: 'Scheduled jobs ran',
      dormantSweep,
      dormantCheckIns,
      interactions,
      meetings,
      projectMeetings,
      meetingLogs,
      digests,
      deadlines,
      retention,
      needMatches,
      analyticsReport,
      missingDocuments,
      offers,
      weeklyReports,
      reEngagement,
      newsletters,
    });
  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
