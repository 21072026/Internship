import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { recipientHash } from '@/lib/mailDeliveryRule';
import { drainOnce, enqueueMail } from '@/lib/mailOutbox';
import { applyDraftAction, type OutboxActor } from '@/lib/outboundDrafts';
import { triggerFor } from '@/lib/outboundApprovalRule';
import { encodeEnvelope, type Envelope } from '@/lib/mailWorkerRule';
import { seal } from '@/lib/secretBox';
import { defaultTemplateForVertical, templateStagePayload } from '@/lib/programTemplates';
import { DECISION_WINDOW_CLAIM } from '@/lib/trialReminderRule';
import { sweepDormantFirstContacts } from '@/lib/dormantFirstContact';
import { expireOffers } from '@/lib/offerNotify';
import { sweepMeetingInteractionLogs } from '@/lib/meetingAutoLog';
import { askForMeetingFeedback } from '@/lib/meetingFeedback';
import { dispatchDueSurveyCampaigns } from '@/lib/surveyCampaigns';
import { sendEvaluationReminders } from '@/lib/evaluationDue';
import { sendDueSurveyReminders } from '@/lib/surveyReminders';
import { dispatchDueNewsletters } from '@/lib/newsletterDispatch';
import { runTrialReminders } from '@/lib/jobs/trialReminders';
import { runReportSubscriptions } from '@/lib/jobs/reportSubscriptions';
import {
  checkCompanyNeedMatches,
  checkMentorInteractionReminders,
  checkReEngagementReminders,
  checkRetentionReminders,
  checkStageDeadlineReminders,
  mailDrainDeps,
  mailMeterIdleForTests,
  resetMailTransportsForTests,
  sendDormantCheckIns,
  sendEmail,
  sendMeetingReminders,
  sendProjectMeetingSeriesReminders,
  sendWeeklyMentorDigests,
  sendWeeklyMissingDocumentReminders,
  sendWeeklyReportReminders,
} from '@/services/emailService';
import { startFakeSmtp, type FakeSmtp } from './helpers/fakeSmtp';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// The mail safety net (#2970, docs/outbound-approval.md § The safety net) on
// top of the outbound approval inbox (#2960).
//
// A synthetic MARKETING org with approval ON, leads in every stage of the
// funnel, a customer login, and a lead that only has a generated stand-in
// address. The daily crons are called directly — the same functions
// /api/cron and the in-process schedules call — and then the database is asked
// the one question that matters: did anything leave for a lead? Zero
// email.send jobs, zero SENT EmailLog rows; what the crons wanted to say is an
// OutboundDraft, and a stand-in address is not even that.
//
// WHERE THE MAIL IS SENT FROM: this process, against a fake SMTP server, like
// outbound-approval.spec.ts — the app server runs with SMTP_USER blank, so
// every mail there would stop at SKIPPED before the hold is ever asked.
// Local database only: it writes email.send jobs a deployed drain would race for.
const local = !process.env.BASE_URL;
const PASSWORD = 'SafetyNet123!';
const STAMP = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const DAY = 86_400_000;
const today = new Date();
const utcDay = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) + offset * DAY);

const E = {
  admin: uniqueEmail(`sn-admin-${STAMP}`),
  rep: uniqueEmail(`sn-rep-${STAMP}`),
  customer: uniqueEmail(`sn-customer-${STAMP}`),
};
// One lead per funnel stage (plus the trial edge cases), keyed by a label.
const LEADS = {
  new: 'LEAD_NEW',
  contacted: 'LEAD_CONTACTED',
  qualified: 'LEAD_QUALIFIED',
  trialSoon: 'TRIAL_ACTIVE',
  trialOver: 'TRIAL_ACTIVE',
  trialLate: 'TRIAL_ACTIVE',
  windowClosing: 'TRIAL_EXPIRED',
  windowStale: 'TRIAL_EXPIRED',
  won: 'DEAL_WON',
  lost: 'DEAL_LOST',
} as const;
type LeadKey = keyof typeof LEADS;
const leadEmail = Object.fromEntries(Object.keys(LEADS).map((k) => [k, uniqueEmail(`sn-lead-${k}-${STAMP}`)])) as Record<LeadKey, string>;
// What the importer / an account event writes for a lead with no known address.
const STAND_IN = `sn.lead.${STAMP}@import.local`;

const ids: Record<string, string> = {};
const rel: Partial<Record<LeadKey | 'standIn', string>> = {};
let orgId = '';
let smtp: FakeSmtp;
const saved: Record<string, string | undefined> = {};
const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_INLINE_TIMEOUT_MS', 'MAIL_METER_MODE', 'MAIL_QUEUE_LANES'];

async function jobsFor(address: string) {
  const rcpt = recipientHash(address);
  const rows = await prisma.job.findMany({ where: { name: 'email.send' } });
  return rows.filter((r) => (r.payload as { rcpt?: string } | null)?.rcpt === rcpt);
}

/** Every address on the lead side of the org: the leads, the customer, the stand-in. */
const leadSide = () => [...Object.values(leadEmail), E.customer, STAND_IN];

test.describe('mail safety net', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!local, 'sends mail from this process against the local database and a fake SMTP server');

  test.beforeAll(async () => {
    smtp = await startFakeSmtp();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = 'safety-net-e2e';
    process.env.SMTP_PASS = 'safety-net-e2e';
    process.env.SMTP_FROM = 'noreply@example.test';
    process.env.NEXTAUTH_SECRET ||= 'e2e-safety-net-secret';
    delete process.env.MAIL_METER_MODE;
    delete process.env.MAIL_INLINE_TIMEOUT_MS;
    delete process.env.MAIL_QUEUE_LANES;
    resetMailTransportsForTests();

    const org = await prisma.organization.create({
      data: { name: `Acme Sales Net ${STAMP}`, slug: `sn-${STAMP}`, vertical: 'MARKETING' },
    });
    orgId = org.id;
    await prisma.pipelineStage.createMany({
      data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId })),
    });
    await prisma.setting.create({ data: { orgId, key: 'outboundApproval', value: 'lead_mail' } });

    ids.admin = (await seedUser(E.admin, PASSWORD, 'ADMIN', `Net Admin ${STAMP}`, orgId)).id;
    ids.rep = (await seedUser(E.rep, PASSWORD, 'MENTOR', `Net Rep ${STAMP}`, orgId)).id;
    ids.customer = (await seedUser(E.customer, PASSWORD, 'COMPANY', `Net Customer ${STAMP}`, orgId)).id;

    const trialEnd: Partial<Record<LeadKey, Date>> = {
      trialSoon: utcDay(3), // the 3-day mark: a reminder to the OWNER
      trialOver: utcDay(-10), // ran out ten days ago: the sweep expires it
      trialLate: utcDay(-10), // same end, but the record was only created today
      windowClosing: utcDay(-25), // window closes in 5 days: one bell
      windowStale: utcDay(-90), // window closed 60 days ago: a historic record
    };
    // The record behind `trialOver` has existed for forty days; `trialLate`
    // keeps the default (now), as a record loaded today with a past end does.
    const startDate: Partial<Record<LeadKey, Date>> = { trialOver: utcDay(-40) };
    for (const [key, stage] of Object.entries(LEADS) as [LeadKey, string][]) {
      const lead = await seedUser(leadEmail[key], PASSWORD, 'MENTEE', `Net Lead ${key} ${STAMP}`, orgId);
      ids[key] = lead.id;
      const r = await prisma.mentorshipRelation.create({
        data: {
          orgId,
          mentorId: ids.rep,
          menteeId: lead.id,
          pipelineStatus: stage,
          trialEndsAt: trialEnd[key] ?? null,
          ...(startDate[key] ? { startDate: startDate[key] } : {}),
        },
      });
      rel[key] = r.id;
    }
    // The stand-in lead: no real address, as an import writes it.
    const standIn = await prisma.user.create({
      data: { email: STAND_IN, password: '!imported-no-login', role: 'MENTEE', fullName: `Net Stand-in ${STAMP}`, skills: [], orgId },
    });
    ids.standIn = standIn.id;
    rel.standIn = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids.rep, menteeId: standIn.id, pipelineStatus: 'LEAD_NEW' } })).id;

    // Somebody the product WOULD write to on its own: a lost lead (and the
    // stand-in) who asked to be contacted again, now due.
    for (const id of [ids.lost, ids.standIn]) {
      await prisma.user.update({ where: { id }, data: { reEngageAt: utcDay(-1) } });
      await prisma.userConsent.create({ data: { userId: id, type: 'RE_ENGAGEMENT_POOL', grantedAt: new Date() } });
    }
  });

  test.afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetMailTransportsForTests();
    await mailMeterIdleForTests().catch(() => {});
    for (const address of [...leadSide(), E.admin, E.rep]) {
      for (const j of await jobsFor(address).catch(() => [])) await prisma.job.delete({ where: { id: j.id } }).catch(() => {});
      await prisma.emailLog.deleteMany({ where: { to: address } }).catch(() => {});
    }
    const relIds = Object.values(rel).filter((v): v is string => !!v);
    await prisma.statusChange.deleteMany({ where: { relationId: { in: relIds } } }).catch(() => {});
    await prisma.trialReminder.deleteMany({ where: { relationId: { in: relIds } } }).catch(() => {});
    await prisma.outboundDraft.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.userConsent.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
    for (const email of [...Object.values(E), ...Object.values(leadEmail), STAND_IN]) await cleanupByEmail(email);
    await prisma.setting.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
    await smtp?.close();
    await prisma.$disconnect();
  });

  test('a stand-in address is refused before anything else: SKIPPED with its reason, no draft, no job', { tag: '@smoke' }, async () => {
    // Approval is ON for this org, so a real lead's address would be HELD. The
    // stand-in never gets that far — and the same holds with no org at all.
    for (const [to, org] of [
      [STAND_IN, orgId],
      [`sn.erased.${STAMP}@erased.local`, null],
    ] as const) {
      const result = await sendEmail({ to, subject: `Net check ${STAMP}`, html: '<p>x</p>', category: 'dormant-check-in', orgId: org });
      expect(result).toBe('SKIPPED');
      const logs = await prisma.emailLog.findMany({ where: { to } });
      expect(logs.map((l) => l.status)).toEqual(['SKIPPED']);
      expect(logs[0].error).toMatch(/^Unmailable address: (placeholder|erased)_address$/);
      expect(await prisma.outboundDraft.count({ where: { rcpt: recipientHash(to) } })).toBe(0);
      expect(await jobsFor(to)).toHaveLength(0);
      expect(smtp.to(to)).toHaveLength(0);
      await prisma.emailLog.deleteMany({ where: { to } });
    }
    // An essential category is refused too: the address is nobody, whatever the mail.
    expect(await sendEmail({ to: STAND_IN, subject: 'Reset', html: '<p>x</p>', category: 'password-reset' })).toBe('SKIPPED');
    await prisma.emailLog.deleteMany({ where: { to: STAND_IN } });
  });

  test('the dormant check-in never runs in a MARKETING org: no claim, no draft', { tag: '@smoke' }, async () => {
    // Flagged dormant long ago, reachable, opted in — everything the job asks
    // for, except a vertical with mentorship.
    await prisma.mentorshipRelation.update({ where: { id: rel.contacted! }, data: { dormantSince: utcDay(-20) } });
    await sendDormantCheckIns();
    const r = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.contacted! } });
    expect(r.dormantNudgeCount).toBe(0);
    expect(r.dormantNudgeSentAt).toBeNull();
    expect(await prisma.outboundDraft.count({ where: { orgId, category: 'dormant-check-in' } })).toBe(0);
    expect(await prisma.emailLog.count({ where: { to: leadEmail.contacted } })).toBe(0);
  });

  test('the daily crons over leads in every stage: nothing leaves for a lead, only drafts', { tag: '@smoke' }, async () => {
    test.setTimeout(180_000);
    const started = new Date();
    const errors: string[] = [];
    const run = async (name: string, fn: () => Promise<unknown>) => {
      try {
        return await fn();
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    };

    // The /api/cron batch, in its own order, then the scheduled sweeps that
    // run on their own clocks — narrowed to this org where the job allows it.
    await run('sweepDormantFirstContacts', () => sweepDormantFirstContacts());
    await run('sendDormantCheckIns', () => sendDormantCheckIns());
    await run('checkMentorInteractionReminders', () => checkMentorInteractionReminders());
    await run('sendMeetingReminders', () => sendMeetingReminders());
    await run('sendProjectMeetingSeriesReminders', () => sendProjectMeetingSeriesReminders());
    const meetingLogs = (await run('sweepMeetingInteractionLogs', () => sweepMeetingInteractionLogs())) as { loggedIds?: string[] } | undefined;
    await run('askForMeetingFeedback', () => askForMeetingFeedback(meetingLogs?.loggedIds ?? []));
    await run('sendWeeklyMentorDigests', () => sendWeeklyMentorDigests());
    await run('checkStageDeadlineReminders', () => checkStageDeadlineReminders());
    await run('checkRetentionReminders', () => checkRetentionReminders());
    await run('checkCompanyNeedMatches', () => checkCompanyNeedMatches());
    await run('sendWeeklyMissingDocumentReminders', () => sendWeeklyMissingDocumentReminders());
    await run('expireOffers', () => expireOffers());
    await run('sendWeeklyReportReminders', () => sendWeeklyReportReminders());
    await run('checkReEngagementReminders', () => checkReEngagementReminders());
    await run('dispatchDueNewsletters', () => dispatchDueNewsletters());
    await run('runTrialReminders', () => runTrialReminders({ orgIds: [orgId] }));
    await run('runReportSubscriptions', () => runReportSubscriptions({ orgIds: [orgId] }));
    await run('dispatchDueSurveyCampaigns', () => dispatchDueSurveyCampaigns(new Date(), { orgIds: [orgId] }));
    await run('sendDueSurveyReminders', () => sendDueSurveyReminders(new Date(), { orgIds: [orgId] }));
    await run('sendEvaluationReminders', () => sendEvaluationReminders(new Date(), { orgIds: [orgId] }));
    expect(errors).toEqual([]);

    // THE NET. Nothing on the queue and nothing SENT for anybody on the lead
    // side; not a byte reached the fake relay for them.
    for (const address of leadSide()) {
      expect(await jobsFor(address), address).toHaveLength(0);
      expect(await prisma.emailLog.count({ where: { to: address, status: { in: ['SENT', 'DEFERRED'] } } }), address).toBe(0);
      expect(smtp.to(address), address).toHaveLength(0);
    }
    // What the crons wanted to say to a lead is a draft — the lost lead's
    // re-engagement mail at least, which proves the held path was exercised.
    const drafts = await prisma.outboundDraft.findMany({ where: { orgId } });
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(d.status).toBe('DRAFT');
    expect(drafts.some((d) => d.recipientUserId === ids.lost && d.category === 're-engagement')).toBe(true);
    // The stand-in lead is not even a draft: it was refused and recorded so.
    expect(await prisma.outboundDraft.count({ where: { rcpt: recipientHash(STAND_IN) } })).toBe(0);
    const standInLogs = await prisma.emailLog.findMany({ where: { to: STAND_IN, createdAt: { gte: started } } });
    expect(standInLogs.length).toBeGreaterThan(0);
    for (const l of standInLogs) {
      expect(l.status).toBe('SKIPPED');
      expect(l.error).toBe('Unmailable address: placeholder_address');
    }
    // No dormant check-in anywhere in this org, sweep or not.
    expect(await prisma.outboundDraft.count({ where: { orgId, category: 'dormant-check-in' } })).toBe(0);
    expect(await prisma.mentorshipRelation.count({ where: { orgId, dormantNudgeCount: { gt: 0 } } })).toBe(0);

    // QUIETER EXPIRY. The trial that ran out ten days ago moved — and its
    // history says it ended then, not this morning; the audit row carries the org.
    const expired = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.trialOver! } });
    expect(expired.pipelineStatus).toBe('TRIAL_EXPIRED');
    const moves = await prisma.statusChange.findMany({ where: { relationId: rel.trialOver! } });
    expect(moves.map((m) => [m.fromStatus, m.toStatus, m.createdAt.toISOString()])).toEqual([
      ['TRIAL_ACTIVE', 'TRIAL_EXPIRED', utcDay(-10).toISOString()],
    ]);
    const audits = await prisma.auditLog.findMany({ where: { action: 'trial.expire', targetId: rel.trialOver! } });
    expect(audits.map((a) => a.orgId)).toEqual([orgId]);
    // ...but never before the record existed: one created today with the same
    // past end expired the moment it was created, not ten days before it.
    const late = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.trialLate! } });
    expect(late.pipelineStatus).toBe('TRIAL_EXPIRED');
    const lateMoves = await prisma.statusChange.findMany({ where: { relationId: rel.trialLate! } });
    expect(lateMoves.map((m) => [m.fromStatus, m.toStatus, m.createdAt.toISOString()])).toEqual([
      ['TRIAL_ACTIVE', 'TRIAL_EXPIRED', late.startDate!.toISOString()],
    ]);

    // NO STALE BELL. The window closing in five days rang its one bell; the
    // one that closed two months ago did not, and stays in the queue unrung.
    const claims = async (relationId: string) =>
      prisma.trialReminder.count({ where: { relationId, threshold: DECISION_WINDOW_CLAIM } });
    expect(await claims(rel.windowClosing!)).toBe(1);
    expect(await claims(rel.windowStale!)).toBe(0);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rel.windowStale! } })).pipelineStatus).toBe('TRIAL_EXPIRED');
  });
  test('a draft or a queued mail from before the net still never reaches a stand-in', { tag: '@smoke' }, async () => {
    // Written as the outbox and the queue stored them before #2970: the
    // stand-in address sealed inside, nothing refused on the way in.
    const prepared = {
      to: STAND_IN,
      subject: `Legacy ${STAMP}`,
      category: 're-engagement',
      transport: 'primary' as const,
      lane: 'BULK' as const,
      message: { html: '<p>x</p>' },
      userId: ids.standIn,
      orgId,
    };
    const draft = await prisma.outboundDraft.create({
      data: {
        orgId,
        status: 'DRAFT',
        category: prepared.category,
        lane: prepared.lane,
        reason: 'held_lead',
        trigger: triggerFor(prepared.category),
        rcpt: recipientHash(STAND_IN),
        recipientUserId: ids.standIn,
        box: seal(encodeEnvelope(prepared as unknown as Envelope), 'outbound-draft'),
        dedupeKey: `sn-legacy-draft-${STAMP}`,
        notAfter: utcDay(7),
      },
    });
    const admin: OutboxActor = { id: ids.admin, role: 'ADMIN', orgId };
    // It cannot be sent or scheduled — only discarded.
    expect(await applyDraftAction(admin, draft.id, 'send')).toEqual({ ok: false, httpStatus: 409, code: 'unmailable' });
    const at = new Date(Date.now() + 60 * 60 * 1000);
    expect(await applyDraftAction(admin, draft.id, 'schedule', { scheduledFor: at })).toEqual({ ok: false, httpStatus: 409, code: 'unmailable' });
    expect((await prisma.outboundDraft.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
    expect(await applyDraftAction(admin, draft.id, 'discard')).toMatchObject({ ok: true, status: 'DISCARDED' });

    // A queued row: the drain cancels it unsent and records why.
    const job = await enqueueMail(prepared, { reason: 'approved', dedupeKey: `sn-legacy-job-${STAMP}` });
    for (let i = 0; i < 5; i++) {
      await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
      if ((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status !== 'PENDING') break;
    }
    const settled = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(settled.status).toBe('CANCELLED');
    expect(settled.lastError).toBe('unmailable');
    expect((settled.payload as Record<string, unknown>).box).toBeNull();
    expect(smtp.to(STAND_IN)).toHaveLength(0);
    const logs = await prisma.emailLog.findMany({ where: { to: STAND_IN, subject: prepared.subject } });
    expect(logs.map((l) => [l.status, l.error])).toEqual([['SKIPPED', 'Unmailable address: placeholder_address']]);
  });
});
