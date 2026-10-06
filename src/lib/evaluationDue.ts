// INTERIM/FINAL evaluation due dates and their reminders (#1891).
//
// RULES THIS FILE IS BUILT AROUND (docs/evaluation-due.md):
//   • THE TENANT'S OWN STAGES. The schedule is a stage KEY per type, read from
//     the org's settings and checked against its resolved pipeline; the
//     built-in keys are only the fallback, and only where the pipeline still
//     has them (src/lib/evaluationDueRule.ts). No stage key is written here.
//   • ONE ROW PER RELATION AND TYPE. EvaluationDue's unique is the claim: two
//     sweeps create one row. A relation that already has that evaluation gets
//     its row created completed, so it is never reminded.
//   • NO BACKFILL. A due date already more than EVALUATION_LOOKBACK_DAYS in the
//     past when first seen is not created — switching this on must not mail
//     every mentor about internships that ended last year.
//   • TWO REMINDERS, NEVER THREE. On the due date, then a week later; each is
//     claimed by one conditional UPDATE on remindersSent.
//   • STOPS ON WRITE. POST /api/evaluations stamps completedAt
//     (markEvaluationCompleted below); the sweep re-checks before it sends.
//   • THE MENTOR'S TASK. Only the relation's mentor is reminded — never the
//     mentee — in-app through the existing goalsEvaluations category and by
//     e-mail in the existing `goals-evaluation` category (no new opt-out).
//
// Registered from /api/cron/start (it sends through emailService); runnable on
// its own as GET /api/cron?job=evaluations.

import cron from 'node-cron';
import type { EvaluationType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getSetting } from '@/lib/settings';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { notifyIfAllowed } from '@/lib/notify';
import { notificationLink } from '@/lib/notificationLink';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import {
  DUE_EVALUATION_TYPES,
  EVALUATION_LOOKBACK_DAYS,
  EVALUATION_MAX_REMINDERS,
  dueDateIsCreatable,
  evaluationReminderDue,
  resolveEvaluationSchedule,
} from '@/lib/evaluationDueRule';
import { emailDictionary } from '@/i18n/emailDictionary';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { emailBrand, sendEmail } from '@/services/emailService';

const DAY = 24 * 60 * 60 * 1000;

export interface EvaluationSweepResult {
  created: number;
  /** Created already completed — the evaluation existed before its due date did. */
  alreadyWritten: number;
  reminded: number;
}

/** Whether `type` has been written about the mentee — by the mentor or an admin, not the mentee's own review of the mentor. */
async function evaluationWritten(relationId: string, menteeId: string, type: EvaluationType): Promise<boolean> {
  return (await prisma.evaluation.count({ where: { relationId, type, authorId: { not: menteeId } } })) > 0;
}

/**
 * Stamp the due row of `type` completed — called by POST /api/evaluations when
 * the mentor or an admin writes it. The mentee's own evaluation of their
 * mentor is not the task the reminder is about, so it stamps nothing.
 */
export async function markEvaluationCompleted(relationId: string, type: EvaluationType, writtenBy: 'mentee' | 'staff', now = new Date()): Promise<void> {
  if (writtenBy !== 'staff') return;
  await prisma.evaluationDue.updateMany({ where: { relationId, type, completedAt: null }, data: { completedAt: now } });
}

/** Create the due rows for relations that entered a configured stage. */
async function createDueRows(orgId: string | null, now: Date, result: EvaluationSweepResult) {
  const stages = await resolvePipelineStages(orgId);
  const schedule = resolveEvaluationSchedule(
    {
      interimStage: await getSetting('evaluationInterimStage', orgId),
      interimDays: await getSetting('evaluationInterimDays', orgId),
      finalStage: await getSetting('evaluationFinalStage', orgId),
    },
    new Set(stages.map((s) => s.key)),
  );
  for (const type of DUE_EVALUATION_TYPES) {
    const entry = schedule[type];
    if (!entry) continue;
    // Only an entry recent enough to give a creatable due date is looked at.
    const windowStart = new Date(now.getTime() - (entry.afterDays + EVALUATION_LOOKBACK_DAYS) * DAY);
    const relations = await prisma.mentorshipRelation.findMany({
      where: {
        orgId,
        status: 'ACTIVE',
        evaluationDues: { none: { type } },
        OR: [
          { statusChanges: { some: { toStatus: entry.stageKey, createdAt: { gte: windowStart } } } },
          // Created straight into the stage: no StatusChange row, the creation is the entry.
          { pipelineStatus: entry.stageKey, startDate: { gte: windowStart }, statusChanges: { none: { toStatus: entry.stageKey } } },
        ],
      },
      select: {
        id: true,
        menteeId: true,
        startDate: true,
        statusChanges: { where: { toStatus: entry.stageKey }, orderBy: { createdAt: 'asc' }, take: 1, select: { createdAt: true } },
      },
    });
    for (const rel of relations) {
      const enteredAt = rel.statusChanges[0]?.createdAt ?? rel.startDate;
      const dueAt = new Date(enteredAt.getTime() + entry.afterDays * DAY);
      if (!dueDateIsCreatable(dueAt, now)) continue;
      const written = await evaluationWritten(rel.id, rel.menteeId, type);
      try {
        await prisma.evaluationDue.create({ data: { orgId, relationId: rel.id, type, dueAt, completedAt: written ? now : null } });
        result.created++;
        if (written) result.alreadyWritten++;
      } catch (error) {
        if ((error as { code?: string })?.code !== 'P2002') throw error; // another sweep claimed it
      }
    }
  }
}

/** Remind the mentor of every due, unwritten evaluation — at most twice. */
async function sendDueReminders(orgIds: (string | null)[] | null, now: Date, result: EvaluationSweepResult) {
  const rows = await prisma.evaluationDue.findMany({
    where: {
      completedAt: null,
      remindersSent: { lt: EVALUATION_MAX_REMINDERS },
      dueAt: { lte: now },
      relation: { status: 'ACTIVE' },
      ...(orgIds ? { OR: orgIds.map((orgId) => ({ orgId })) } : {}),
    },
    include: {
      relation: {
        select: {
          id: true,
          orgId: true,
          mentorId: true,
          menteeId: true,
          mentee: { select: { fullName: true } },
          mentor: { select: { email: true, fullName: true, preferredLanguage: true, isActive: true } },
        },
      },
    },
  });
  for (const row of rows) {
    if (!evaluationReminderDue(row, now)) continue;
    // Belt and braces: an evaluation written by a path that did not stamp the row.
    if (await evaluationWritten(row.relationId, row.relation.menteeId, row.type)) {
      await prisma.evaluationDue.updateMany({ where: { id: row.id, completedAt: null }, data: { completedAt: now } });
      continue;
    }
    const claimed = await prisma.evaluationDue.updateMany({
      where: { id: row.id, remindersSent: row.remindersSent, completedAt: null },
      data: { remindersSent: { increment: 1 }, lastRemindedAt: now },
    });
    if (claimed.count !== 1) continue;
    result.reminded++;
    await remindMentor(row.relation, row.type, row.remindersSent + 1);
  }
}

async function remindMentor(
  rel: { id: string; orgId: string | null; mentorId: string; mentee: { fullName: string }; mentor: { email: string; fullName: string; preferredLanguage: string | null; isActive: boolean } },
  type: EvaluationType,
  n: number,
) {
  const link = notificationLink('MENTOR', 'relation', { relationId: rel.id }, { capabilities: await shellCapabilities(rel.orgId) });
  await notifyIfAllowed(rel.mentorId, 'goalsEvaluations', type === 'FINAL' ? 'evaluation.dueFinal' : 'evaluation.dueInterim', { menteeName: rel.mentee.fullName }, link);
  if (!rel.mentor.isActive) return;
  const locale: Locale = isLocale(rel.mentor.preferredLanguage ?? undefined) ? (rel.mentor.preferredLanguage as Locale) : defaultLocale;
  const org = await settingsOrgOfRow(rel.orgId);
  const t = (await emailDictionary(locale, org)).evaluationDue;
  const brand = await emailBrand(org);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const subject = (type === 'FINAL' ? t.subjectFinal : t.subjectInterim).replace('{mentee}', rel.mentee.fullName);
  const body = (type === 'FINAL' ? t.bodyFinal : t.bodyInterim).replace('{mentor}', rel.mentor.fullName).replace('{mentee}', rel.mentee.fullName);
  await sendEmail({
    category: 'goals-evaluation',
    userId: rel.mentorId,
    orgId: rel.orgId,
    locale,
    to: rel.mentor.email,
    subject,
    html: `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
        ${body.split('\n').map((line) => `<p>${esc(line)}</p>`).join('')}
        <p><a href="${esc(`${brand.appUrl}${link}`)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${esc(brand.accent)};color:#fff;text-decoration:none;">${esc(t.cta)}</a></p>
        ${n >= EVALUATION_MAX_REMINDERS ? `<p style="font-size:12px;color:#6b7280;">${esc(t.lastReminder)}</p>` : ''}
      </div>`,
  }).catch((error) => logger.error('Evaluation reminder failed', { relationId: rel.id, error: String(error) }));
}

/**
 * The sweep: create the due rows, then send the reminders that are due.
 * `orgIds` narrows it to those tenants (an admin's `job=evaluations`); without
 * it every org with an active relation is swept.
 */
export async function sendEvaluationReminders(now = new Date(), opts: { orgIds?: string[] } = {}): Promise<EvaluationSweepResult> {
  const result: EvaluationSweepResult = { created: 0, alreadyWritten: 0, reminded: 0 };
  const orgIds: (string | null)[] = opts.orgIds
    ?? (await prisma.mentorshipRelation.groupBy({ by: ['orgId'], where: { status: 'ACTIVE' } })).map((g) => g.orgId);
  const swept: (string | null)[] = [];
  for (const orgId of orgIds) {
    // A vertical without evaluations (MARKETING) has nothing to be reminded of.
    if (!(await shellCapabilities(orgId)).includes('evaluations')) continue;
    swept.push(orgId);
    await createDueRows(orgId, now, result);
  }
  if (swept.length > 0) await sendDueReminders(swept, now, result);
  return result;
}

// Coverage for the scorecard lives in src/lib/evaluationCoverage.ts (no mail
// imports), re-exported here so this stays the module that explains it all.
export { evaluationCoverage } from '@/lib/evaluationCoverage';

// ── Scheduling ───────────────────────────────────────────────────────────────

let task: cron.ScheduledTask | null = null;

/**
 * Daily at 08:15 UTC — morning in DE/TR, when a mentor plans the day. From
 * /api/cron/start, never initCronJobs: this module sends through emailService.
 */
export function initEvaluationRemindersCron() {
  if (task) return;
  task = cron.schedule('15 8 * * *', async () => {
    try {
      const r = await sendEvaluationReminders();
      if (r.created || r.reminded) logger.warning('Evaluation reminders ran', { ...r });
    } catch (error) {
      logger.error('Evaluation reminders failed', { error: String(error) });
    }
  });
}
