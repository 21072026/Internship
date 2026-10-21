// Org-defined segmentation attributes (#1920) — the Prisma-aware half. The
// rules (types, keys, value shapes, tenure) are pure in orgAttributesRule.ts;
// this file reads the org's attributes with their value counts and handles the
// one thing deletion must not do: leave a saved view or a scheduled report
// pointing at a dimension that no longer exists. docs/analytics.md.

import { prisma } from '@/lib/prisma';

export interface OrgAttributeDto {
  id: string;
  key: string;
  labelEn: string;
  labelTr: string;
  labelDe: string;
  type: string;
  options: string[];
  appliesTo: string;
  isSegmentable: boolean;
  sortOrder: number;
  /** How many people carry a value. */
  valueCount: number;
}

const select = {
  id: true,
  key: true,
  labelEn: true,
  labelTr: true,
  labelDe: true,
  type: true,
  options: true,
  appliesTo: true,
  isSegmentable: true,
  sortOrder: true,
} as const;

/** The org's attributes in display order, each with its value count — two queries in all. */
export async function listOrgAttributes(orgId: string): Promise<OrgAttributeDto[]> {
  const [attributes, counts] = await Promise.all([
    prisma.orgAttribute.findMany({ where: { orgId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select }),
    prisma.userAttributeValue.groupBy({ by: ['attributeId'], where: { orgId }, _count: { _all: true } }),
  ]);
  const byId = new Map(counts.map((c) => [c.attributeId, c._count._all]));
  return attributes.map((a) => ({
    ...a,
    options: Array.isArray(a.options) ? (a.options as unknown[]).filter((o): o is string => typeof o === 'string') : [],
    valueCount: byId.get(a.id) ?? 0,
  }));
}

/** The segmentation parameter a saved view's filters or a subscription's params may carry. */
export const SEGMENT_PARAM = 'segmentBy';
const SEGMENT_VALUE_PARAM = 'segment';

function refersTo(json: unknown, key: string): boolean {
  return !!json && typeof json === 'object' && !Array.isArray(json) && (json as Record<string, unknown>)[SEGMENT_PARAM] === key;
}

function withoutSegment(json: unknown): Record<string, unknown> {
  const out = { ...(json as Record<string, unknown>) };
  delete out[SEGMENT_PARAM];
  delete out[SEGMENT_VALUE_PARAM];
  return out;
}

/**
 * The saved views and report subscriptions of the org that slice by `key`.
 * Both stores are JSON, so the match is done here over the org's rows — a
 * handful per org, read only when an admin is about to delete an attribute.
 */
export async function attributeReferences(orgId: string, key: string) {
  const [views, subscriptions] = await Promise.all([
    prisma.savedView.findMany({ where: { orgId }, select: { id: true, filters: true } }),
    prisma.reportSubscription.findMany({ where: { orgId }, select: { id: true, params: true } }),
  ]);
  return {
    views: views.filter((v) => refersTo(v.filters, key)),
    subscriptions: subscriptions.filter((s) => refersTo(s.params, key)),
  };
}

/**
 * Delete an attribute (its values go with it, by cascade) and degrade every
 * saved view and subscription that sliced by it to the unsegmented report —
 * in one transaction, so a scheduled send never reads a half-deleted state.
 * The report loader treats an unknown `segmentBy` as unsegmented as well, so
 * a reference written in between still cannot 500.
 */
export async function deleteOrgAttribute(orgId: string, attributeId: string, key: string) {
  const refs = await attributeReferences(orgId, key);
  await prisma.$transaction([
    ...refs.views.map((v) => prisma.savedView.update({ where: { id: v.id }, data: { filters: withoutSegment(v.filters) as object } })),
    ...refs.subscriptions.map((s) => prisma.reportSubscription.update({ where: { id: s.id }, data: { params: withoutSegment(s.params) as object } })),
    prisma.orgAttribute.delete({ where: { id: attributeId } }),
  ]);
  return { views: refs.views.length, subscriptions: refs.subscriptions.length };
}
