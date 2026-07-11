import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import {
  checkMentorInteractionReminders,
  sendMeetingReminders,
  sendWeeklyMentorDigests,
  checkStageDeadlineReminders,
  checkRetentionReminders,
  checkCompanyNeedMatches,
  sendWeeklyAnalyticsReport,
} from '@/services/emailService';

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [interactions, meetings, digests, deadlines, retention, needMatches, analyticsReport] = await Promise.all([
      checkMentorInteractionReminders(),
      sendMeetingReminders(),
      sendWeeklyMentorDigests(),
      checkStageDeadlineReminders(),
      checkRetentionReminders(),
      checkCompanyNeedMatches(),
      sendWeeklyAnalyticsReport(),
    ]);

    return NextResponse.json({
      message: 'Scheduled jobs ran',
      interactions,
      meetings,
      digests,
      deadlines,
      retention,
      needMatches,
      analyticsReport,
    });
  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
