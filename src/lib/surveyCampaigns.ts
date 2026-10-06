// Survey campaigns (#1887): the programme sends the survey, not an admin.
// `dueCampaignTargets()` resolves every active campaign into
// { campaign, user, relation, periodKey } targets; `dispatchDueSurveyCampaigns()`
// claims each target, mints an invitation (#1881) and sends the mail.
//
// RULES THIS FILE IS BUILT AROUND (docs/surveys.md § Campaigns):
//   • CLAIM FIRST. A SurveyCampaignSend row, unique on (campaign, user,
//     period), is written before the invitation is minted or the mail sent —
//     two sweeps, or two overlapping ticks, send one invitation.
//   • THE TENANT'S OWN STAGES. A stage trigger resolves its key through the
//     org's resolved stage set and reads StatusChange rows; a key the org does
//     not have simply never fires (and a renamed stage keeps its key).
//   • NO BACKFILL. Every trigger looks back at most LOOKBACK_DAYS and never
//     before the campaign was created, so the first sweep after it is set up
//     does not mail the whole history.
//   • BATCH CAP. One tick sends at most SWEEP_BATCH invitations; the rest are
//     picked up next tick (a claimed target is never sent twice, an unclaimed
//     one is simply still due).
//   • OPT-OUT FIRST. Someone who switched the `surveys` e-mail group off, or
//     whose account is inactive, is not claimed and not invited.
// node-cron is only the carrier until the leader-elected scheduler (#1668);
// the sweep is a plain exported function either way.

import cron from 'node-cron';
import type { MentorshipRelation, SurveyAudience, SurveyCampaign, User } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { orgWhere } from '@/lib/tenantFilter';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { emailGroupAllowed } from '@/lib/emailGroups';
import { settingsOrgOfRow } from '@/lib/settingsOrg';
import { surveyAcceptsAnswers } from '@/lib/surveys';
import { createSurveyInvitation, surveyInviteUrl, SURVEY_INVITE_TTL_DAYS } from '@/lib/surveyTokens';
import { sendDueSurveyReminders } from '@/lib/surveyReminders';
import { emailDictionary } from '@/i18n/emailDictionary';
import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { formatDate } from '@/lib/relativeTime';
import { emailBrand, sendEmail } from '@/services/emailService';

export const SWEEP_BATCH = 50;
export const LOOKBACK_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

type Person = Pick<User, 'id' | 'email' | 'fullName' | 'isActive' | 'preferredLanguage' | 'notificationPrefs' | 'orgId'>;
const PERSON = { id: true, email: true, fullName: true, isActive: true, preferredLanguage: true, notificationPrefs: true, orgId: true } as const;

export interface CampaignTarget {
  campaign: SurveyCampaign;
  user: Person;
  relationId: string | null;
  periodKey: string;
}

type RelationWithPeople = Pick<MentorshipRelation, 'id'> & { mentor: Person; mentee: Person };

/** Who of a relation the campaign speaks to. COMPANY has no relation-side person and is not sent here. */
function peopleFor(audience: SurveyAudience, r: RelationWithPeople): Person[] {
  if (audience === 'MENTEE') return [r.mentee];
  if (audience === 'MENTOR') return [r.mentor];
  if (audience === 'BOTH') return [r.mentee, r.mentor];
  return [];
}

const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Resolve every active campaign (optionally of some orgs) into due targets. */
export async function dueCampaignTargets(now = new Date(), opts: { orgIds?: string[] } = {}): Promise<CampaignTarget[]> {
  const campaigns = await prisma.surveyCampaign.findMany({
    where: { active: true, ...(opts.orgIds ? { orgId: { in: opts.orgIds } } : {}) },
    include: { survey: { select: { audience: true, status: true, opensAt: true, closesAt: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const targets: CampaignTarget[] = [];
  const stageCache = new Map<string, Promise<Set<string>>>();
  const stageKeysOf = (orgId: string | null) => {
    const k = orgId ?? '';
    if (!stageCache.has(k)) stageCache.set(k, resolvePipelineStages(orgId).then((st) => new Set(st.map((s) => s.key))));
    return stageCache.get(k)!;
  };

  for (const campaign of campaigns) {
    if (!surveyAcceptsAnswers(campaign.survey, now)) continue;
    const audience = campaign.audience ?? campaign.survey.audience;
    // The window: never before the campaign existed, never more than the lookback.
    const since = new Date(Math.max(campaign.createdAt.getTime(), now.getTime() - LOOKBACK_DAYS * DAY));
    const scope = campaign.orgId ? await orgWhere(campaign.orgId) : {};
    const relSelect = { id: true, startDate: true, stageDeadline: true, mentor: { select: PERSON }, mentee: { select: PERSON } } as const;
    const push = (r: RelationWithPeople, periodKey: string) => {
      for (const user of peopleFor(audience, r)) targets.push({ campaign, user, relationId: r.id, periodKey });
    };

    switch (campaign.trigger) {
      case 'STAGE_ENTERED': {
        if (!campaign.stageKey || !(await stageKeysOf(campaign.orgId)).has(campaign.stageKey)) break;
        const moves = await prisma.statusChange.findMany({
          where: { toStatus: campaign.stageKey, createdAt: { gte: since, lte: now }, relation: scope },
          select: { relation: { select: relSelect } },
          distinct: ['relationId'],
        });
        for (const m of moves) push(m.relation, `stage:${campaign.stageKey}`);
        break;
      }
      case 'DAYS_AFTER_START': {
        if (campaign.dayOffset == null) break;
        // The relations whose start + offset fell inside the window.
        const rels = await prisma.mentorshipRelation.findMany({
          where: { ...scope, status: 'ACTIVE', startDate: { gte: new Date(since.getTime() - campaign.dayOffset * DAY), lte: new Date(now.getTime() - campaign.dayOffset * DAY) } },
          select: relSelect,
        });
        for (const r of rels) push(r, `day:${campaign.dayOffset}`);
        break;
      }
      case 'DAYS_BEFORE_END': {
        if (campaign.dayOffset == null) break;
        // The relations whose stage deadline is now `dayOffset` days (or fewer,
        // within the lookback) away. One send per deadline: a moved deadline is
        // a new period.
        const rels = await prisma.mentorshipRelation.findMany({
          where: { ...scope, status: 'ACTIVE', stageDeadline: { gte: now, lte: new Date(now.getTime() + campaign.dayOffset * DAY) } },
          select: relSelect,
        });
        for (const r of rels) {
          const reachedAt = new Date(r.stageDeadline!.getTime() - campaign.dayOffset * DAY);
          if (reachedAt >= since) push(r, `before:${isoDay(r.stageDeadline!)}`);
        }
        break;
      }
      case 'RECURRING': {
        if (!campaign.everyDays || campaign.everyDays < 1) break;
        // Round n starts at createdAt + n·everyDays; round 0 is the first sweep.
        const round = Math.floor((utcDay(now).getTime() - utcDay(campaign.createdAt).getTime()) / (campaign.everyDays * DAY));
        const rels = await prisma.mentorshipRelation.findMany({ where: { ...scope, status: 'ACTIVE' }, select: relSelect });
        for (const r of rels) push(r, `pulse:${round}`);
        break;
      }
      case 'MANUAL': {
        // Once to the whole active audience, as soon as the campaign is active.
        const rels = await prisma.mentorshipRelation.findMany({ where: { ...scope, status: 'ACTIVE' }, select: relSelect });
        for (const r of rels) push(r, 'manual');
        break;
      }
    }
  }
  return targets;
}

export interface DispatchResult {
  due: number;
  sent: number;
  skipped: number;
  deferred: number;
}

/** Claim, invite and mail every due target, at most SWEEP_BATCH per tick. */
export async function dispatchDueSurveyCampaigns(now = new Date(), opts: { orgIds?: string[]; batch?: number } = {}): Promise<DispatchResult> {
  // A caller may lower the cap (an admin re-running one tick), never raise it.
  const cap = Math.min(opts.batch ?? SWEEP_BATCH, SWEEP_BATCH);
  const targets = await dueCampaignTargets(now, opts);
  const result: DispatchResult = { due: targets.length, sent: 0, skipped: 0, deferred: 0 };
  const seen = new Set<string>();

  for (const target of targets) {
    const { campaign, user, periodKey } = target;
    // A person reachable through two relations in one period is one target.
    const key = `${campaign.id}|${user.id}|${periodKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!user.isActive || !emailGroupAllowed(user, 'surveys')) {
      result.skipped++;
      continue;
    }
    if (result.sent >= cap) {
      result.deferred++;
      continue;
    }
    // CLAIM before anything is minted or sent.
    let claim: { id: string };
    try {
      claim = await prisma.surveyCampaignSend.create({
        data: { campaignId: campaign.id, userId: user.id, relationId: target.relationId, periodKey },
        select: { id: true },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') continue; // already sent this period
      throw error;
    }
    const round = periodKey.startsWith('pulse:') ? periodKey : '';
    const invite = await createSurveyInvitation({ surveyId: campaign.surveyId, orgId: campaign.orgId, email: user.email, userId: user.id, locale: user.preferredLanguage, round, now });
    // Already invited to this survey round by another campaign: the claim
    // stands (so it is not retried), and nobody gets a second link.
    if (!invite) continue;
    await prisma.surveyCampaignSend.update({ where: { id: claim.id }, data: { invitationId: invite.invitationId } });
    await sendInvite(user, campaign, invite.token, now);
    result.sent++;
  }

  if (targets.length > 0) {
    await prisma.surveyCampaign.updateMany({ where: { id: { in: [...new Set(targets.map((t) => t.campaign.id))] } }, data: { lastRunAt: now } });
  }
  return result;
}

async function sendInvite(user: Person, campaign: SurveyCampaign, token: string, now: Date) {
  const locale: Locale = isLocale(user.preferredLanguage ?? undefined) ? (user.preferredLanguage as Locale) : defaultLocale;
  const org = await settingsOrgOfRow(campaign.orgId ?? user.orgId);
  const t = await emailDictionary(locale, org);
  const brand = await emailBrand(org);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const url = surveyInviteUrl(token, brand.appUrl);
  const body = t.programSurvey.invite.body.replace('{name}', user.fullName);
  const expires = t.surveyCampaign.expires.replace('{date}', formatDate(new Date(now.getTime() + SURVEY_INVITE_TTL_DAYS * DAY), locale));
  await sendEmail({
    category: 'survey-invite',
    userId: user.id,
    orgId: user.orgId,
    locale,
    to: user.email,
    subject: t.programSurvey.invite.subject,
    html: `<div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
        ${body.split('\n').map((line) => `<p>${esc(line)}</p>`).join('')}
        <p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${esc(brand.accent)};color:#fff;text-decoration:none;">${esc(t.surveyCampaign.cta)}</a></p>
        <p style="font-size:12px;color:#6b7280;">${esc(expires)}</p>
      </div>`,
  }).catch((error) => logger.error('Survey invite failed', { campaignId: campaign.id, userId: user.id, error: String(error) }));
}

// ── Scheduling ───────────────────────────────────────────────────────────────


const tasks = new Map<string, cron.ScheduledTask>();

/**
 * Daily at 10:00 UTC — mid-morning in DE/TR, when a short survey gets read.
 * Registered from /api/cron/start, never from initCronJobs: this module sends
 * through emailService, and importing it there would close the import cycle.
 */
export function initSurveyCampaignsCron() {
  if (tasks.has('surveys')) return;
  const task = cron.schedule('0 10 * * *', async () => {
    try {
      const r = await dispatchDueSurveyCampaigns();
      if (r.due) logger.warning('Survey campaigns ran', { ...r });
      // Reminders after the invitations (#1889): today's new invitations are
      // not due for days, so the order only keeps one log line per pass.
      const reminders = await sendDueSurveyReminders();
      if (reminders.due) logger.warning('Survey reminders ran', { ...reminders });
    } catch (error) {
      logger.error('Survey campaigns failed', { error: String(error) });
    }
  });
  tasks.set('surveys', task);
}
