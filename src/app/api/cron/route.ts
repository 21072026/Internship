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
} from '@/services/emailService';
import { expireOffers } from '@/lib/offerNotify';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [interactions, meetings, projectMeetings, digests, deadlines, retention, needMatches, analyticsReport, offers] = await Promise.all([
      checkMentorInteractionReminders(),
      sendMeetingReminders(),
      sendProjectMeetingSeriesReminders(),
      sendWeeklyMentorDigests(),
      checkStageDeadlineReminders(),
      checkRetentionReminders(),
      checkCompanyNeedMatches(),
      sendWeeklyAnalyticsReport(),
      expireOffers(),
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
      offers,
    });
  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
