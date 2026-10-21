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
  sendWeeklyReportReminders,
  sendWeeklyMissingDocumentReminders,
  runEmailHealthCheck,
  checkReEngagementReminders,
  sendDormantCheckIns,
} from '@/services/emailService';
import { expireOffers } from '@/lib/offerNotify';
import { sweepMeetingInteractionLogs } from '@/lib/meetingAutoLog';
import { askForMeetingFeedback } from '@/lib/meetingFeedback';
import { dispatchDueSurveyCampaigns } from '@/lib/surveyCampaigns';
import { sendEvaluationReminders } from '@/lib/evaluationDue';
import { runProgramJourney } from '@/lib/programJourney';
import { sendDueSurveyReminders } from '@/lib/surveyReminders';
import { dispatchDueNewsletters, queueScheduledNewsletter } from '@/lib/newsletterDispatch';
import { sweepDormantFirstContacts } from '@/lib/dormantFirstContact';
import { runDeadLetterAlert } from '@/lib/jobs/dlqAlert';
import { runAuditDrains } from '@/lib/auditDrain';
import { runRetentionPrune } from '@/lib/retentionEntries';
import { runUsageRollup } from '@/lib/jobs/usageRollup';
import { runTrialReminders } from '@/lib/jobs/trialReminders';
import { runReportSubscriptions } from '@/lib/jobs/reportSubscriptions';
import { sweepRelationHealth } from '@/lib/jobs/relationHealthSweep';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { runSsoCertificateExpiry } from '@/lib/jobs/ssoCertificateExpiry';
import { isSuperAdmin, isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';

// The named jobs that are scoped to the CALLER's own organization (they read
// it from the session, never from the request). Every other job — and the
// batch, which is what an unnamed or unknown job falls through to — sweeps
// every tenant and answers with instance-wide totals: the operator's trigger,
// so it takes a super admin (#1575). A tenant ADMIN asking for one gets a 403
// and an `authz.scope_denied` audit row, never a run.
const OWN_ORG_JOBS = new Set(['relation-health', 'evaluations', 'program-journey', 'surveys', 'report-subscriptions']);

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = new URL(request.url).searchParams;
    const job = params.get('job');
    // trial-reminders with `orgId` names ONE tenant: the caller's own, or one a
    // super admin of the caller's world reaches (super admin is per world,
    // #2647). Anything else would let one tenant's ADMIN run another tenant's
    // trial sweep — its mails, bells and TRIAL_ACTIVE → TRIAL_EXPIRED moves.
    const targetOrgId = job === 'trial-reminders' ? params.get('orgId') : null;
    if (targetOrgId) {
      if (targetOrgId !== (await settingsOrgOf(session)) && !(await isSuperAdminFor(session, targetOrgId))) {
        await logCrossTenantDenial(session, '/api/cron?job=trial-reminders', targetOrgId);
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    } else if (!OWN_ORG_JOBS.has(job ?? '') && !(await isSuperAdmin(session))) {
      await logCrossTenantDenial(session, `/api/cron?job=${job ?? 'batch'}`, null);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

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
      const meetingLogs = await sweepMeetingInteractionLogs();
      // The meetings nobody ended get their one feedback ask (#1896).
      const feedbackAsked = await askForMeetingFeedback(meetingLogs.loggedIds);
      return NextResponse.json({ message: 'Meeting interaction logs ran', meetingLogs, feedbackAsked });
    }
    // Retention re-consent reminders alone — the same function the batch runs,
    // idempotent by `retentionReminderSentAt`. Named so an operator (and
    // e2e/tenant-scope-retention.spec.ts, which checks the per-org admin
    // summary, #2542) can run it without the whole batch.
    if (job === 'retention') {
      return NextResponse.json({ message: 'Retention reminders ran', retention: await checkRetentionReminders() });
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
    // Dead-letter alert (#1674) — named only, deliberately NOT part of the
    // batch below. The batch is "run everything now", which an admin may click
    // several times while fixing something; the alert's whole contract is one
    // mail a day, and it is silent when the queue is clean either way.
    if (job === 'audit-drain') {
      // One tick of the audit stream (#2012): every due drain, platform-wide.
      return NextResponse.json({ message: 'Audit drain ran', auditDrain: await runAuditDrains() });
    }
    if (job === 'dlq-alert') {
      return NextResponse.json({ message: 'Dead-letter alert ran', dlqAlert: await runDeadLetterAlert() });
    }
    // Retention (#1678) — named only, deliberately NOT part of the batch
    // below, for the same reason as the dead-letter alert: the batch is "run
    // everything now" and an admin may click it several times while fixing
    // something, while this one deletes rows. Irreversible work asks to be
    // asked for.
    // `retention-prune`, not `retention`: it shared that name with the
    // reminders branch above, which answered first, so the prune was
    // unreachable from here (#1575).
    if (job === 'retention-prune') {
      return NextResponse.json({ message: 'Retention prune ran', retentionPrune: await runRetentionPrune() });
    }
    // Usage rollup (#1750) — named only, and for the opposite reason to the two
    // above: it is the one job here that is *completely* safe to click twice
    // (every metric it writes is recomputed and set absolutely), but it is also
    // the one nothing else in the batch needs. An admin runs it when they want
    // this month's billing numbers refreshed now rather than at 02:40.
    if (job === 'usage-rollup') {
      return NextResponse.json({ message: 'Usage rollup ran', usageRollup: await runUsageRollup() });
    }
    // Trial reminders (#2415, story #2392) — named only, deliberately NOT part
    // of the batch below. Two reasons, and they are not the same reason the
    // three jobs above have: this one is MARKETING-vertical work that means
    // nothing on an INTERNSHIP box, and it also moves records between pipeline
    // stages (the auto-expiry, #2417), which is not what "run the mail jobs
    // now" should quietly do. An admin runs it when they want today's trial
    // sweep now rather than at 05:20.
    // Report subscriptions (#1905): the caller's own org only — an admin may
    // fire their tenant's due reports, never another tenant's. `?at=` pins the
    // clock so the idempotency of a period can be exercised.
    // Relationship health (#1901): the caller's own org only. `?at=` pins the
    // clock so the snapshot day and the crossing rule can be exercised.
    if (job === 'relation-health') {
      const orgId = await settingsOrgOf(session);
      const at = new URL(request.url).searchParams.get('at');
      const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
      return NextResponse.json({ message: 'Relation health sweep ran', relationHealth: await sweepRelationHealth({ orgIds: [orgId], now }) });
    }
    // Evaluation due dates and reminders (#1891): the caller's own org only.
    // `?at=` pins the clock so the due date and the week-later second reminder
    // can be exercised.
    if (job === 'evaluations') {
      const orgId = await settingsOrgOf(session);
      const at = new URL(request.url).searchParams.get('at');
      const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
      return NextResponse.json({ message: 'Evaluation reminders ran', evaluations: await sendEvaluationReminders(now, { orgIds: [orgId] }) });
    }
    // Program journey steps (#1852): the caller's own org only. `?at=` pins the
    // clock so a step's due day and the claim's idempotency can be exercised.
    if (job === 'program-journey') {
      const orgId = await settingsOrgOf(session);
      const at = new URL(request.url).searchParams.get('at');
      const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
      return NextResponse.json({ message: 'Program journey ran', programJourney: await runProgramJourney({ orgIds: [orgId], now }) });
    }
    // Survey campaigns (#1887): the caller's own org only, and only this
    // sweep. `?at=` pins the clock so a trigger's window can be exercised.
    if (job === 'surveys') {
      const orgId = await settingsOrgOf(session);
      const at = new URL(request.url).searchParams.get('at');
      const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
      // `?batch=` can only LOWER the per-tick cap (dispatchDueSurveyCampaigns clamps it).
      const batch = parseInt(new URL(request.url).searchParams.get('batch') ?? '', 10);
      const opts = { orgIds: [orgId], batch: Number.isFinite(batch) && batch > 0 ? batch : undefined };
      const surveys = await dispatchDueSurveyCampaigns(now, opts);
      // The reminder pass (#1889) runs in the same tick, after the invitations.
      return NextResponse.json({ message: 'Survey campaigns ran', surveys, surveyReminders: await sendDueSurveyReminders(now, opts) });
    }
    if (job === 'report-subscriptions') {
      const orgId = await settingsOrgOf(session);
      const at = new URL(request.url).searchParams.get('at');
      const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
      return NextResponse.json({ message: 'Report subscriptions ran', reportSubscriptions: await runReportSubscriptions({ orgIds: [orgId], now }) });
    }
    if (job === 'trial-reminders') {
      // `orgId` NARROWS the sweep to one tenant, and only to one the caller
      // may act on (checked above, #1575): their own org, or one a super admin
      // of their world reaches. Without it the sweep is platform-wide, so it
      // is a super admin's. Two callers want the narrow form: an operator
      // re-running one customer's sweep after fixing that customer's data, and
      // e2e/trial-reminders-job.spec.ts, which must assert exact counts without
      // being perturbed by whatever else is in the database — the same reason
      // `runUsageRollup()` takes `orgIds`.
      const trialReminders = await runTrialReminders(targetOrgId ? { orgIds: [targetOrgId] } : {});
      return NextResponse.json({ message: 'Trial reminders ran', trialReminders });
    }
    // IdP certificate-expiry warnings alone (#1933). `orgId` narrows the sweep
    // (never broadens it) and `at` moves "now", for the same reason the trial
    // job takes them: e2e/sso-metadata-import.spec.ts asserts exact mails.
    if (job === 'sso-certificates') {
      const params = new URL(request.url).searchParams;
      const orgId = params.get('orgId');
      const at = params.get('at');
      const now = at && !Number.isNaN(Date.parse(at)) ? new Date(at) : undefined;
      const ssoCertificates = await runSsoCertificateExpiry({ ...(orgId ? { orgIds: [orgId] } : {}), now });
      return NextResponse.json({ message: 'SSO certificate warnings ran', ssoCertificates });
    }
    // Recurring-meeting reminders alone (#2013) — the same function the batch
    // runs, and as safe to click twice: every occurrence is claimed in
    // MeetingSeriesReminder before anything is sent. Named so an operator (and
    // e2e/relation-series-reach.spec.ts) can run it without the whole batch.
    if (job === 'meeting-series-reminders') {
      return NextResponse.json({ message: 'Meeting series reminders ran', projectMeetings: await sendProjectMeetingSeriesReminders() });
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

    const [interactions, meetings, projectMeetings, meetingLogs, digests, deadlines, retention, needMatches, missingDocuments, offers, weeklyReports, reEngagement, newsletters] = await Promise.all([
      checkMentorInteractionReminders(),
      sendMeetingReminders(),
      sendProjectMeetingSeriesReminders(),
      sweepMeetingInteractionLogs(),
      sendWeeklyMentorDigests(),
      checkStageDeadlineReminders(),
      checkRetentionReminders(),
      checkCompanyNeedMatches(),
      sendWeeklyMissingDocumentReminders(),
      expireOffers(),
      sendWeeklyReportReminders(),
      checkReEngagementReminders(),
      dispatchDueNewsletters(),
    ]);
    // Asked after the sweep, never alongside it: it reads the ids the sweep
    // just logged (#1896).
    const feedbackAsked = await askForMeetingFeedback(meetingLogs.loggedIds);

    return NextResponse.json({
      message: 'Scheduled jobs ran',
      dormantSweep,
      dormantCheckIns,
      interactions,
      meetings,
      projectMeetings,
      meetingLogs,
      feedbackAsked,
      digests,
      deadlines,
      retention,
      needMatches,
      // The weekly analytics report is a subscription now (#1905): the
      // caller's own org's due subscriptions, never another tenant's.
      reportSubscriptions: await runReportSubscriptions({ orgIds: [await settingsOrgOf(session)] }),
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
