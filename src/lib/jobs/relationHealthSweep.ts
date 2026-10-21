// The nightly relationship-health sweep (#1901). For every ACTIVE relation:
// load the signals, score them with the published rules table (#1898,
// src/lib/relationHealth.ts), upsert TODAY's RelationHealthSnapshot, and — if
// the pair just crossed into AT_RISK — put it in its org admins' daily digest.
// Rows past the retention window are pruned by the same pass.
//
// Safe to re-run: the snapshot is an upsert on (relationId, takenOn), and an
// alert is marked on the snapshot it belongs to, so a second pass the same day
// neither adds a row nor mails again.
//
// node-cron is the carrier only until the leader-elected scheduler (#1676)
// lands; sweepRelationHealth() is the handler either way. Registered from
// /api/cron/start, never from initCronJobs, to keep the import graph one-way.

import { scheduleLeased } from '@/lib/jobs/leasedCron';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { orgWhere } from '@/lib/tenantFilter';
import { assessRelations, HEALTH_RELATION_SELECT, reminderDaysReader, type HealthRelationRow } from '@/lib/relationHealthLive';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import type { HealthReason } from '@/lib/relationHealth';
import { SNAPSHOT_RETENTION_DAYS, shouldAlert, utcDay } from '@/lib/relationHealthTrend';
import { emailDictionary } from '@/i18n/emailDictionary';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { emailBrand, sendEmail } from '@/services/emailService';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 500;

/** One pair that crossed into AT_RISK tonight — what the admin digest lists. */
export interface Crossing {
  orgId: string;
  relationOrgId: string | null;
  menteeId: string;
  menteeName: string;
  mentorName: string;
  pipelineStatus: string;
  reasons: HealthReason[];
  daysSinceContact: number | null;
  score: number | null;
}

export interface SweepResult {
  scored: number;
  excluded: number;
  crossings: number;
  mailed: number;
  pruned: number;
}

export async function sweepRelationHealth(opts: { now?: Date; orgIds?: string[] } = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const today = utcDay(now);
  const yesterday = new Date(today.getTime() - DAY);
  const result: SweepResult = { scored: 0, excluded: 0, crossings: 0, mailed: 0, pruned: 0 };
  const crossings: Crossing[] = [];

  const scope: Prisma.MentorshipRelationWhereInput = { status: 'ACTIVE' };
  if (opts.orgIds) scope.OR = await Promise.all(opts.orgIds.map((id) => orgWhere(id)));

  // reminderDays is an org setting (the same "stale" the digest uses), read
  // once per org per pass.
  const reminderDaysFor = reminderDaysReader();

  let cursor: string | undefined;
  for (;;) {
    const rows: HealthRelationRow[] = await prisma.mentorshipRelation.findMany({
      where: scope,
      select: HEALTH_RELATION_SELECT,
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    const ids = rows.map((r) => r.id);

    const [assessed, previous] = await Promise.all([
      assessRelations(rows, now, reminderDaysFor),
      prisma.relationHealthSnapshot.findMany({
        where: { relationId: { in: ids }, OR: [{ takenOn: { in: [yesterday, today] } }, { alertedAt: { not: null } }] },
        select: { relationId: true, takenOn: true, band: true, alertedAt: true },
      }),
    ]);

    for (const { row: r, assessment, lastContactAt } of assessed) {
      if (assessment.excluded) {
        result.excluded++;
        continue;
      }
      result.scored++;

      const mine = previous.filter((p) => p.relationId === r.id);
      const todays = mine.find((p) => p.takenOn.getTime() === today.getTime());
      const yesterdays = mine.find((p) => p.takenOn.getTime() === yesterday.getTime());
      const lastAlert = mine
        .filter((p) => p.alertedAt && p.takenOn.getTime() < today.getTime())
        .sort((a, b) => b.takenOn.getTime() - a.takenOn.getTime())[0];
      const alert =
        !todays?.alertedAt &&
        shouldAlert({
          today,
          todayBand: assessment.band,
          yesterdayBand: (yesterdays?.band as typeof assessment.band | undefined) ?? null,
          lastAlertOn: lastAlert?.takenOn ?? null,
        });

      const data = { score: assessment.score, band: assessment.band, reasons: assessment.reasons, rulesVersion: assessment.version };
      await prisma.relationHealthSnapshot.upsert({
        where: { relationId_takenOn: { relationId: r.id, takenOn: today } },
        create: { relationId: r.id, orgId: r.orgId, takenOn: today, ...data, ...(alert ? { alertedAt: now } : {}) },
        // Never clears an alert mark: re-running the day must not re-alert.
        update: { ...data, ...(alert ? { alertedAt: now } : {}) },
      });
      if (alert) {
        crossings.push({
          orgId: await settingsOrgOfRow(r.orgId),
          relationOrgId: r.orgId,
          menteeId: r.mentee.id,
          menteeName: r.mentee.fullName,
          mentorName: r.mentor.fullName,
          pipelineStatus: r.pipelineStatus,
          reasons: assessment.reasons,
          daysSinceContact: lastContactAt ? Math.floor((now.getTime() - lastContactAt.getTime()) / DAY) : null,
          score: assessment.score,
        });
      }
    }
  }

  // The one table here that grows without bound otherwise.
  const pruned = await prisma.relationHealthSnapshot.deleteMany({
    where: { takenOn: { lt: new Date(today.getTime() - SNAPSHOT_RETENTION_DAYS * DAY) } },
  });
  result.pruned = pruned.count;
  result.crossings = crossings.length;
  result.mailed = await mailCrossingDigests(crossings);
  return result;
}

/** One digest per admin of each org that has crossings tonight, in the admin's language. */
async function mailCrossingDigests(crossings: Crossing[]): Promise<number> {
  if (crossings.length === 0) return 0;
  const byOrg = new Map<string, Crossing[]>();
  for (const c of crossings) byOrg.set(c.orgId, [...(byOrg.get(c.orgId) ?? []), c]);

  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', isActive: true },
    select: { id: true, orgId: true, email: true, fullName: true, preferredLanguage: true },
  });
  const labels = new Map<string, Promise<(key: string) => string>>();
  const labelFor = (orgId: string | null, locale: Locale) => {
    const key = `${orgId ?? ''}|${locale}`;
    if (!labels.has(key)) labels.set(key, resolvePipelineStages(orgId, locale).then((stages) => (k: string) => stageLabel(stages, k, locale)));
    return labels.get(key)!;
  };

  let mailed = 0;
  for (const admin of admins) {
    const org = await settingsOrgOfRow(admin.orgId);
    const list = byOrg.get(org);
    if (!list) continue;
    const locale: Locale = isLocale(admin.preferredLanguage ?? undefined) ? (admin.preferredLanguage as Locale) : defaultLocale;
    const t = await emailDictionary(locale, org);
    const H = t.relationHealth;
    const brand = await emailBrand(org);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const reasonText = (c: Crossing, reason: HealthReason) =>
      reason === 'inactive'
        ? c.daysSinceContact === null
          ? H.reason.inactiveNever
          : H.reason.inactive.replace('{n}', String(c.daysSinceContact))
        : H.reason[reason];
    const items: string[] = [];
    for (const c of list) {
      const stage = (await labelFor(c.relationOrgId, locale))(c.pipelineStatus);
      items.push(
        `<li style="margin-bottom:10px;"><a href="${esc(brand.appUrl)}/admin/candidates/${esc(c.menteeId)}"><strong>${esc(c.menteeName)}</strong></a>` +
          ` · ${esc(H.withMentor.replace('{mentor}', c.mentorName))} · ${esc(stage)}<br/>` +
          `<span style="color:#b91c1c;">${esc(c.reasons.map((r) => reasonText(c, r)).join(' · '))}</span></li>`,
      );
    }
    const subject = H.subject.replace('{n}', String(list.length)).replace('{product}', brand.name);
    await sendEmail({
      category: 'program-health',
      userId: admin.id,
      orgId: admin.orgId,
      locale,
      to: admin.email,
      subject,
      html: `<div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
          <h2 style="color:${esc(brand.accent)};">${esc(H.heading)}</h2>
          <p>${esc(H.greeting.replace('{name}', admin.fullName))}</p>
          <p>${esc(H.intro)}</p>
          <ul style="padding-left:18px;">${items.join('')}</ul>
          <p style="font-size:12px;color:#6b7280;">${esc(H.footer)}</p>
        </div>`,
    }).catch((error) => logger.error('Relation health digest failed', { userId: admin.id, error: String(error) }));
    mailed++;
  }
  return mailed;
}

const tasks = new Map<string, ReturnType<typeof scheduleLeased>>();

/** Nightly at 02:00 — before anyone's day starts, after the day's writes. */
export function initRelationHealthCron() {
  if (tasks.has('relation-health')) return;
  const task = scheduleLeased('0 2 * * *', async () => {
    try {
      const r = await sweepRelationHealth();
      logger.warning('Relation health sweep ran', { ...r });
    } catch (error) {
      logger.error('Relation health sweep failed', { error: String(error) });
    }
  });
  tasks.set('relation-health', task);
}
