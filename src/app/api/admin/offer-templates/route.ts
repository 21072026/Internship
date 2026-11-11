import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { logActivity } from '@/lib/activity';
import { locales, type Locale } from '@/i18n/config';
import { OFFER_TEMPLATE_MAX } from '@/lib/offerLetter';
import { BUILT_IN_OFFER_LETTERS } from '@/lib/offerLetterTemplates';

// The org's offer letter template per locale (#1857).
//
// GET    → { templates: [{ locale, bodyMarkdown, custom, builtIn }] } for every locale
// PUT    { locale, bodyMarkdown } → the org's default template for that locale
// DELETE ?locale=xx → back to the built-in letter (the org's row goes; a
//        sent offer is unaffected — it carries its own frozen snapshot)
//
// Same gate as the other org settings: `org.settings.write`, and the
// `placements` module (offers do not exist without it). The org is the
// session's (resolveOrgId); another org's template is unreachable by shape.

const DEFAULT_NAME = 'default';
const localeSchema = z.enum(locales as unknown as [Locale, ...Locale[]]);
const putSchema = z.object({ locale: localeSchema, bodyMarkdown: z.string().trim().min(1).max(OFFER_TEMPLATE_MAX) });

async function gate(request: Request) {
  const g = await requirePermission('org.settings.write', { request });
  if ('error' in g) return { error: g.error };
  const cap = await requireCapability(g.session.user.orgId, 'placements');
  if (cap) return { error: cap };
  const orgId = resolveOrgId(g.session);
  if (!orgId) return { error: NextResponse.json({ error: 'No organization' }, { status: 400 }) };
  return { session: g.session, orgId };
}

export async function GET(request: Request) {
  const g = await gate(request);
  if ('error' in g) return g.error;
  return withTenantScope(g.session, async () => {
    const rows = await prisma.offerTemplate.findMany({
      where: { orgId: g.orgId, isDefault: true },
      select: { locale: true, bodyMarkdown: true, updatedAt: true },
    });
    const templates = locales.map((locale) => {
      const row = rows.find((r) => r.locale === locale);
      return {
        locale,
        bodyMarkdown: row?.bodyMarkdown ?? BUILT_IN_OFFER_LETTERS[locale],
        custom: !!row,
        updatedAt: row?.updatedAt ?? null,
        builtIn: BUILT_IN_OFFER_LETTERS[locale],
      };
    });
    return NextResponse.json({ templates });
  });
}

export async function PUT(request: Request) {
  const g = await gate(request);
  if ('error' in g) return g.error;
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const { locale, bodyMarkdown } = parsed.data;
  return withTenantScope(g.session, async () => {
    const row = await prisma.offerTemplate.upsert({
      where: { orgId_locale_name: { orgId: g.orgId, locale, name: DEFAULT_NAME } },
      create: { orgId: g.orgId, locale, name: DEFAULT_NAME, bodyMarkdown, isDefault: true },
      update: { bodyMarkdown, isDefault: true },
      select: { locale: true, bodyMarkdown: true, updatedAt: true },
    });
    await logActivity({
      action: 'offer_template.save',
      actorId: g.session.user.id,
      actorEmail: g.session.user.email ?? null,
      targetType: 'offer_template',
      targetId: locale,
    });
    return NextResponse.json({ template: { ...row, custom: true } });
  });
}

export async function DELETE(request: Request) {
  const g = await gate(request);
  if ('error' in g) return g.error;
  const parsed = localeSchema.safeParse(new URL(request.url).searchParams.get('locale'));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(g.session, async () => {
    await prisma.offerTemplate.deleteMany({ where: { orgId: g.orgId, locale: parsed.data, name: DEFAULT_NAME } });
    await logActivity({
      action: 'offer_template.reset',
      actorId: g.session.user.id,
      actorEmail: g.session.user.email ?? null,
      targetType: 'offer_template',
      targetId: parsed.data,
    });
    return NextResponse.json({ ok: true });
  });
}
