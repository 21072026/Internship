// The admin side of nudges (#1686): what /api/admin/nudges reads and writes.
// Server-only. Every query names the caller's org; the vocabulary and the
// write-time gate are ./rule.ts, the evaluation (and its dry run) ./evaluate.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import type { Locale } from '@/i18n/config';
import { nudgeGuardStageKeys, nudgeRuleSelect } from './evaluate';
import { NUDGE_EVENT_TRIGGERS, missingLocales, parseNudgeRuleInput, readStoredNudge, type NudgeRuleInputResult } from './rule';

/** The editor's pick lists: the org's stages, cohorts and tags, and the event triggers. */
export async function nudgeEditorOptions(orgId: string, locale: Locale) {
  const [stages, guard, cohorts, tags] = await Promise.all([
    resolvePipelineStages(orgId, locale),
    nudgeGuardStageKeys(orgId),
    prisma.cohort.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.tag.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
  ]);
  return {
    // A guarded stage is offered as "not in" only: a nudge never reaches someone whose journey ended.
    stages: stages.map((s) => ({ key: s.key, label: s.label, guarded: guard.has(s.key) })),
    cohorts,
    tags,
    events: [...NUDGE_EVENT_TRIGGERS],
  };
}

/** The write-time gate, answered for the caller's org. */
export async function parseForOrg(input: unknown, orgId: string): Promise<NudgeRuleInputResult> {
  const guard = await nudgeGuardStageKeys(orgId);
  return parseNudgeRuleInput(input, (k) => guard.has(k));
}

export function ruleData(rule: Extract<NudgeRuleInputResult, { ok: true }>['rule']) {
  return {
    name: rule.name,
    enabled: rule.enabled,
    trigger: rule.trigger as Prisma.InputJsonValue,
    segment: rule.segment as Prisma.InputJsonValue,
    delayMinutes: rule.delayMinutes,
    channel: rule.channel,
    subjectEn: rule.subjectEn || null,
    subjectTr: rule.subjectTr || null,
    subjectDe: rule.subjectDe || null,
    bodyEn: rule.bodyEn || null,
    bodyTr: rule.bodyTr || null,
    bodyDe: rule.bodyDe || null,
    maxPerUserPer30Days: rule.maxPerUserPer30Days,
    cooldownDays: rule.cooldownDays,
  };
}

const fullSelect = { ...nudgeRuleSelect, lastEvaluatedAt: true, createdAt: true, updatedAt: true } as const;

export async function loadRule(id: string, orgId: string) {
  const row = await prisma.nudgeRule.findFirst({ where: { id, orgId }, select: fullSelect });
  if (!row) return null;
  return { ...row, missingLocales: missingLocales(row) };
}

/** The list: every rule of the org with its sends in the last 30 days. */
export async function listRules(orgId: string, now: Date = new Date()) {
  const rows = await prisma.nudgeRule.findMany({ where: { orgId }, select: fullSelect, orderBy: { createdAt: 'desc' } });
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const counts = rows.length
    ? await prisma.nudgeSend.groupBy({
        by: ['ruleId'],
        where: { orgId, ruleId: { in: rows.map((r) => r.id) }, sentAt: { gte: since }, status: { in: ['SENT', 'HELD'] } },
        _count: { _all: true },
      })
    : [];
  const byRule = new Map(counts.map((c) => [c.ruleId, c._count._all]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: readStoredNudge(r)?.trigger ?? null,
    channel: r.channel,
    lastEvaluatedAt: r.lastEvaluatedAt,
    sentLast30Days: byRule.get(r.id) ?? 0,
    missingLocales: missingLocales(r),
  }));
}

/** A rule's send history, newest first, with the recipient's name and the triggering event's name. */
export async function listSends(ruleId: string, orgId: string, take = 100) {
  const sends = await prisma.nudgeSend.findMany({
    where: { ruleId, orgId },
    orderBy: { sentAt: 'desc' },
    take,
    select: { id: true, userId: true, sentAt: true, channel: true, status: true, eventId: true },
  });
  const [users, events] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [...new Set(sends.map((s) => s.userId))] }, orgId }, select: { id: true, fullName: true } }),
    prisma.domainEvent.findMany({
      where: { id: { in: [...new Set(sends.map((s) => s.eventId).filter((e): e is string => !!e))] }, orgId },
      select: { id: true, name: true },
    }),
  ]);
  const name = new Map(users.map((u) => [u.id, u.fullName]));
  const eventName = new Map(events.map((e) => [e.id, e.name]));
  return sends.map((s) => ({
    id: s.id,
    recipient: name.get(s.userId) ?? null,
    sentAt: s.sentAt,
    channel: s.channel,
    status: s.status,
    event: s.eventId ? (eventName.get(s.eventId) ?? null) : null,
  }));
}
