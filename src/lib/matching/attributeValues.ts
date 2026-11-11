/**
 * The values the `attribute:<key>` dimensions read (#3424), loaded IN BULK:
 * one query per side of a pass — every org-attribute value of every person in
 * it — never one per person or per pair. A round of 200 mentees against 40
 * mentors is two queries.
 *
 * The client is a parameter so the unit test can count the calls; callers pass
 * the Prisma singleton. Server-only by use, not by import.
 */

import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { attributeLabel } from '@/lib/orgAttributesRule';

interface ValueRow { userId: string; value: string; attribute: { key: string } }
interface AttributeRow { key: string; type: string; labelEn: string; labelTr: string; labelDe: string }

/** The two delegates this module reads — the Prisma client satisfies it. */
export interface AttributeValueDb {
  userAttributeValue: { findMany(args: object): Promise<ValueRow[]> };
  orgAttribute: { findMany(args: object): Promise<AttributeRow[]> };
}

/**
 * The tenant for a model whose `orgId` is REQUIRED. The default org's tenant
 * also admits `orgId: null` (legacy users), which a non-nullable column cannot
 * be compared with — Prisma refuses the query outright. An attribute row
 * always names its org, so the concrete org alone is the same filter.
 */
function requiredOrgTenant(tenant: TenantWhere): TenantWhere {
  if ('OR' in tenant && Array.isArray(tenant.OR)) return { orgId: tenant.OR[0].orgId };
  return tenant;
}

/** Every attribute value of `userIds` in ONE query, as userId → key → value. */
export async function loadAttributeValues(db: AttributeValueDb, tenant: TenantWhere, userIds: readonly string[]): Promise<Map<string, Record<string, string>>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.userAttributeValue.findMany({
    where: withinTenant({ userId: { in: [...new Set(userIds)] } }, requiredOrgTenant(tenant)),
    select: { userId: true, value: true, attribute: { select: { key: true } } },
  });
  const out = new Map<string, Record<string, string>>();
  for (const r of rows) out.set(r.userId, { ...out.get(r.userId), [r.attribute.key]: r.value });
  return out;
}

/** `people` with their attributes attached — the shape the dimensions read. */
export async function withAttributeValues<P extends { id: string }>(db: AttributeValueDb, tenant: TenantWhere, people: P[]): Promise<(P & { attributes?: Record<string, string> })[]> {
  const values = await loadAttributeValues(db, tenant, people.map((p) => p.id));
  if (values.size === 0) return people;
  return people.map((p) => (values.has(p.id) ? { ...p, attributes: values.get(p.id) } : p));
}

export interface MatchableAttribute {
  key: string;
  type: string;
  labels: { en: string; tr: string; de: string };
}

/** The org's own attributes, for the rule-set editor — the only keys a rule may name. */
export async function matchableAttributes(db: AttributeValueDb, tenant: TenantWhere): Promise<MatchableAttribute[]> {
  const rows = await db.orgAttribute.findMany({
    where: withinTenant({ appliesTo: 'USER' }, requiredOrgTenant(tenant)),
    select: { key: true, type: true, labelEn: true, labelTr: true, labelDe: true },
    orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
  });
  return rows.map((r) => ({ key: r.key, type: r.type, labels: { en: attributeLabel(r, 'en'), tr: attributeLabel(r, 'tr'), de: attributeLabel(r, 'de') } }));
}

/**
 * The `attribute:<key>` rules whose key is not an attribute of the org —
 * refused at the save. One that is deleted LATER stays in the saved set and
 * scores as not applicable; that is the scorer's business, not this one's.
 */
export async function unknownAttributes(db: AttributeValueDb, tenant: TenantWhere, dimensions: readonly string[]): Promise<string[]> {
  const asked = dimensions.filter((d) => d.startsWith('attribute:'));
  if (asked.length === 0) return [];
  const known = new Set((await matchableAttributes(db, tenant)).map((a) => `attribute:${a.key}`));
  return [...new Set(asked.filter((d) => !known.has(d)))];
}
