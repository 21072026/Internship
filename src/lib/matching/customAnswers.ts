/**
 * The answers the `customField:<key>` dimensions read (#1803), loaded IN BULK:
 * one query for the org's matchable field keys and one for every answer of
 * every person in the pass — never a query per pair or per person. A round of
 * 200 mentees against 40 mentors is still two queries.
 *
 * The client is a parameter so the unit test can count the calls; callers pass
 * the Prisma singleton. Server-only by use, not by import.
 */

import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import type { LocalizedText } from '@/lib/forms/schema';

interface FieldRow { key: string; type: string; labels: unknown }
interface AnswerRow { userId: string; fieldKey: string; value: unknown; updatedAt: Date }

/** The two delegates this module reads — the Prisma client satisfies it. */
export interface CustomAnswerDb {
  formField: { findMany(args: object): Promise<FieldRow[]> };
  formResponse: { findMany(args: object): Promise<AnswerRow[]> };
}

export interface MatchableField {
  key: string;
  type: string;
  labels: LocalizedText;
}

/**
 * The org's matchable questions: on a live (published, not archived) form, not
 * archived themselves. One entry per key — the newest form's labels win.
 */
export async function matchableCustomFields(db: CustomAnswerDb, tenant: TenantWhere): Promise<MatchableField[]> {
  const rows = await db.formField.findMany({
    where: { matchable: true, archivedAt: null, definition: withinTenant({ publishedAt: { not: null }, archivedAt: null }, tenant) },
    select: { key: true, type: true, labels: true },
    orderBy: { key: 'asc' },
  });
  const out = new Map<string, MatchableField>();
  for (const r of rows) if (!out.has(r.key)) out.set(r.key, { key: r.key, type: r.type, labels: (r.labels ?? {}) as LocalizedText });
  return [...out.values()];
}

/** Fold answer rows into userId → fieldKey → the LATEST value (any form version). */
export function foldAnswers(rows: readonly AnswerRow[]): Map<string, Record<string, unknown>> {
  const latest = new Map<string, AnswerRow>();
  for (const r of rows) {
    const k = `${r.userId}\u0000${r.fieldKey}`;
    const prev = latest.get(k);
    if (!prev || r.updatedAt.getTime() > prev.updatedAt.getTime()) latest.set(k, r);
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const r of latest.values()) out.set(r.userId, { ...out.get(r.userId), [r.fieldKey]: r.value });
  return out;
}

/** Every matchable answer of `userIds`, in two queries (one when the org has no matchable field). */
export async function loadCustomAnswers(db: CustomAnswerDb, tenant: TenantWhere, userIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  if (userIds.length === 0) return new Map();
  const keys = (await matchableCustomFields(db, tenant)).map((f) => f.key);
  if (keys.length === 0) return new Map();
  const rows = await db.formResponse.findMany({
    where: withinTenant({ userId: { in: [...new Set(userIds)] }, fieldKey: { in: keys } }, tenant),
    select: { userId: true, fieldKey: true, value: true, updatedAt: true },
  });
  return foldAnswers(rows);
}

/** `people` with their answers attached — the shape the dimensions read. */
export async function withCustomAnswers<P extends { id: string }>(db: CustomAnswerDb, tenant: TenantWhere, people: P[]): Promise<(P & { customAnswers?: Record<string, unknown> })[]> {
  const answers = await loadCustomAnswers(db, tenant, people.map((p) => p.id));
  if (answers.size === 0) return people;
  return people.map((p) => (answers.has(p.id) ? { ...p, customAnswers: answers.get(p.id) } : p));
}

/**
 * The `customField:<key>` rules whose key is not a matchable question of the
 * org — refused at the save, so a rule set can never weight free text or a
 * question nobody is asked. Built-in dimensions are not this function's business.
 */
export async function unmatchableCustomFields(db: CustomAnswerDb, tenant: TenantWhere, dimensions: readonly string[]): Promise<string[]> {
  const custom = dimensions.filter((d) => d.startsWith('customField:'));
  if (custom.length === 0) return [];
  const allowed = new Set((await matchableCustomFields(db, tenant)).map((f) => `customField:${f.key}`));
  return [...new Set(custom.filter((d) => !allowed.has(d)))];
}
