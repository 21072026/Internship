import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import {
  ATTRIBUTE_TYPES,
  MAX_ATTRIBUTES_PER_ORG,
  MAX_LABEL_LENGTH,
  isAttributeKey,
  isAttributeTarget,
  keyFromLabel,
  normalizeOptions,
} from '@/lib/orgAttributesRule';
import { attributeReferences, deleteOrgAttribute, listOrgAttributes } from '@/lib/orgAttributes';
import { requirePermission } from '@/lib/authz';

// The org's segmentation attributes (#1920): define, label in EN/TR/DE, set a
// SELECT's options, reorder, mark segmentable, and see how many people carry a
// value. The values arrive through the admin import; the reports slice by them
// (docs/analytics.md § Dimensions). One org's attributes only — the org is the
// session's (settingsOrgOf), and another org's id answers like a missing one.
//
// No presets are offered or accepted: the vocabulary is generic on purpose.
//
// DELETE of an attribute a saved view or a scheduled report slices by answers
// 409 `referenced` with the counts first; with `confirm: true` it deletes and
// degrades those to the unsegmented report in the same transaction.

const label = z.string().trim().max(MAX_LABEL_LENGTH);
const labels = z.object({ en: label.optional(), tr: label.optional(), de: label.optional() });

const createSchema = z.object({
  key: z.string().trim().optional(),
  labels,
  type: z.enum(ATTRIBUTE_TYPES),
  options: z.array(z.string()).optional(),
  appliesTo: z.string().optional(),
  isSegmentable: z.boolean().optional(),
});
const updateSchema = z.object({
  id: z.string().min(1),
  labels: labels.optional(),
  options: z.array(z.string()).optional(),
  isSegmentable: z.boolean().optional(),
});
const reorderSchema = z.object({ order: z.array(z.string().min(1)).min(1).max(MAX_ATTRIBUTES_PER_ORG) });
const deleteSchema = z.object({ id: z.string().min(1), confirm: z.boolean().optional() });


function labelColumns(input: z.infer<typeof labels>) {
  return { labelEn: input.en?.trim() ?? '', labelTr: input.tr?.trim() ?? '', labelDe: input.de?.trim() ?? '' };
}

const hasLabel = (l: { labelEn: string; labelTr: string; labelDe: string }) => !!(l.labelEn || l.labelTr || l.labelDe);

// GET — the org's attributes in display order, with value counts.
export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => NextResponse.json({ attributes: await listOrgAttributes(orgId) }));
}

// POST — define an attribute. A label in at least one language; the key is
// typed or derived from the first label, and is fixed once created (it is what
// saved views, subscriptions and import files name).
export async function POST(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const cols = labelColumns(parsed.data.labels);
    if (!hasLabel(cols)) return NextResponse.json({ error: 'Write the label in at least one language', code: 'label_required' }, { status: 400 });
    const key = parsed.data.key ? parsed.data.key : keyFromLabel(cols.labelEn || cols.labelTr || cols.labelDe);
    if (!isAttributeKey(key)) return NextResponse.json({ error: 'Key must be lower-case letters, digits and _', code: 'invalid_key' }, { status: 400 });
    const appliesTo = parsed.data.appliesTo ?? 'USER';
    if (!isAttributeTarget(appliesTo)) return NextResponse.json({ error: 'Unsupported target', code: 'invalid_target' }, { status: 400 });
    const options = parsed.data.type === 'SELECT' ? normalizeOptions(parsed.data.options) : [];
    if (parsed.data.type === 'SELECT' && options.length === 0) {
      return NextResponse.json({ error: 'A list needs at least one option', code: 'options_required' }, { status: 400 });
    }
    const existing = await prisma.orgAttribute.findMany({ where: { orgId }, select: { key: true, sortOrder: true } });
    if (existing.length >= MAX_ATTRIBUTES_PER_ORG) return NextResponse.json({ error: 'Too many attributes', code: 'too_many' }, { status: 400 });
    if (existing.some((a) => a.key === key)) return NextResponse.json({ error: 'That key is taken', code: 'duplicate' }, { status: 409 });
    const created = await prisma.orgAttribute.create({
      data: {
        orgId,
        key,
        ...cols,
        type: parsed.data.type,
        options: parsed.data.type === 'SELECT' ? options : undefined,
        appliesTo,
        isSegmentable: parsed.data.isSegmentable ?? true,
        sortOrder: existing.reduce((max, a) => Math.max(max, a.sortOrder + 1), 0),
      },
      select: { id: true },
    });
    const attribute = (await listOrgAttributes(orgId)).find((a) => a.id === created.id);
    return NextResponse.json({ attribute }, { status: 201 });
  });
}

// PATCH — relabel, change a SELECT's options, toggle segmentable; or, with
// `order: [ids]`, reorder the whole list. Type and key are fixed: changing
// either would silently reinterpret every value already stored.
export async function PATCH(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const body = await request.json().catch(() => null);
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const reorder = reorderSchema.safeParse(body);
    if (reorder.success) {
      const own = await prisma.orgAttribute.findMany({ where: { orgId }, select: { id: true } });
      const ownIds = new Set(own.map((a) => a.id));
      if (reorder.data.order.length !== own.length || !reorder.data.order.every((id) => ownIds.has(id))) {
        return NextResponse.json({ error: 'The order must list every attribute once', code: 'invalid_order' }, { status: 400 });
      }
      await prisma.$transaction(reorder.data.order.map((id, i) => prisma.orgAttribute.update({ where: { id }, data: { sortOrder: i } })));
      return NextResponse.json({ attributes: await listOrgAttributes(orgId) });
    }

    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const target = await prisma.orgAttribute.findFirst({ where: { id: parsed.data.id, orgId }, select: { id: true, type: true } });
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const data: Record<string, unknown> = {};
    if (parsed.data.labels) {
      const cols = labelColumns(parsed.data.labels);
      if (!hasLabel(cols)) return NextResponse.json({ error: 'Write the label in at least one language', code: 'label_required' }, { status: 400 });
      Object.assign(data, cols);
    }
    if (parsed.data.options) {
      if (target.type !== 'SELECT') return NextResponse.json({ error: 'Only a list has options', code: 'not_a_list' }, { status: 400 });
      const options = normalizeOptions(parsed.data.options);
      if (options.length === 0) return NextResponse.json({ error: 'A list needs at least one option', code: 'options_required' }, { status: 400 });
      data.options = options;
    }
    if (parsed.data.isSegmentable !== undefined) data.isSegmentable = parsed.data.isSegmentable;
    if (Object.keys(data).length > 0) await prisma.orgAttribute.update({ where: { id: target.id }, data });
    const attribute = (await listOrgAttributes(orgId)).find((a) => a.id === target.id);
    return NextResponse.json({ attribute });
  });
}

// DELETE — remove an attribute and its values. Referenced → 409 first.
export async function DELETE(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => {
    const target = await prisma.orgAttribute.findFirst({ where: { id: parsed.data.id, orgId }, select: { id: true, key: true } });
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!parsed.data.confirm) {
      const refs = await attributeReferences(orgId, target.key);
      if (refs.views.length + refs.subscriptions.length > 0) {
        return NextResponse.json(
          { error: 'Referenced by saved views or report subscriptions', code: 'referenced', views: refs.views.length, subscriptions: refs.subscriptions.length },
          { status: 409 }
        );
      }
    }
    const degraded = await deleteOrgAttribute(orgId, target.id, target.key);
    return NextResponse.json({ ok: true, degraded });
  });
}
