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
  sendWeeklyMissingDocumentReminders,
} from '@/services/emailService';

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (new URL(request.url).searchParams.get('job') === 'missing-documents') {
      const missingDocuments = await sendWeeklyMissingDocumentReminders();
      return NextResponse.json({ message: 'Missing-document reminders ran', missingDocuments });
    }

    const [interactions, meetings, projectMeetings, digests, deadlines, retention, needMatches, analyticsReport, missingDocuments] = await Promise.all([
      checkMentorInteractionReminders(),
      sendMeetingReminders(),
      sendProjectMeetingSeriesReminders(),
      sendWeeklyMentorDigests(),
      checkStageDeadlineReminders(),
      checkRetentionReminders(),
      checkCompanyNeedMatches(),
      sendWeeklyAnalyticsReport(),
      sendWeeklyMissingDocumentReminders(),
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
    });
  } catch (error) {
    console.error('Cron error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
