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
} from '@/services/emailService';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (new URL(request.url).searchParams.get('job') === 'weekly-reports') {
      return NextResponse.json({ message: 'Weekly report reminders ran', weeklyReports: await sendWeeklyReportReminders() });
    }
    const [interactions, meetings, projectMeetings, digests, deadlines, retention, needMatches, analyticsReport, weeklyReports] = await Promise.all([
      checkMentorInteractionReminders(),
      sendMeetingReminders(),
      sendProjectMeetingSeriesReminders(),
      sendWeeklyMentorDigests(),
      checkStageDeadlineReminders(),
      checkRetentionReminders(),
      checkCompanyNeedMatches(),
      sendWeeklyAnalyticsReport(),
      sendWeeklyReportReminders(),
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
      weeklyReports,
    });
  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
