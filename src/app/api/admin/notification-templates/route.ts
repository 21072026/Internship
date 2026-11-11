import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { locales, isLocale } from '@/i18n/config';
import { codeDefault } from '@/lib/notifications/templates';
import { checkTemplateDraft, editableEvent, eventsByGroup, mergeTagsFor, samplePayload } from '@/lib/notifications/templateAdmin';
import { BODY_MAX, SUBJECT_MAX } from '@/lib/notifications/templateRender';

// The org's notification templates (#1718 data, #1719 editor).
//
// GET lists every event whose mail can be edited, grouped by e-mail group, with
// each locale's current source (`program` | `org` | `default`), the stored copy
// and who changed it last; PUT saves one locale variant; DELETE removes it, so
// the code default (or, for a programme, the org's row) applies again.
//
// The org is the CALLER's (`settingsOrgOf(session)`), never a request value; a
// `programId` must name one of that org's programmes (another org's reads as
// missing). Behind `org.settings.write`, so a PROGRAM_ADMIN or OBSERVER is
// refused server-side. Every write is an ActivityLog row. The body an admin
// stores is untrusted: it is sanitised at render time (templateRender.ts), and a
// template that would fall back to the default when sent is refused here.

async function programScope(orgId: string, programId: string | null | undefined): Promise<string | false> {
  if (!programId) return '';
  const p = await prisma.cohort.findFirst({ where: { id: programId, orgId }, select: { id: true } });
  return p ? p.id : false;
}

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  const programIdIn = new URL(request.url).searchParams.get('programId');
  return withTenantScope(gate.session, async () => {
    const programId = await programScope(orgId, programIdIn);
    if (programId === false) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const [rows, programs] = await Promise.all([
      prisma.notificationTemplate.findMany({
        where: { orgId, programId: { in: programId ? ['', programId] : [''] } },
        select: { eventKey: true, locale: true, programId: true, subject: true, body: true, updatedAt: true, updatedById: true },
      }),
      prisma.cohort.findMany({ where: { orgId }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 200 }),
    ]);
    const editorIds = [...new Set(rows.map((r) => r.updatedById).filter((v): v is string => !!v))];
    const editors = editorIds.length
      ? await prisma.user.findMany({ where: { id: { in: editorIds }, orgId }, select: { id: true, fullName: true } })
      : [];
    const editorName = new Map(editors.map((u) => [u.id, u.fullName]));

    const groups = eventsByGroup().map(({ group, events }) => ({
      group,
      events: events.map((def) => ({
        key: def.key,
        tags: mergeTagsFor(def),
        locales: Object.fromEntries(
          locales.map((locale) => {
            const own = programId ? rows.find((r) => r.eventKey === def.key && r.locale === locale && r.programId === programId) : null;
            const org = rows.find((r) => r.eventKey === def.key && r.locale === locale && r.programId === '');
            const row = own ?? org ?? null;
            const fallback = codeDefault(def.key, locale, samplePayload(def));
            return [
              locale,
              {
                source: own ? 'program' : org ? 'org' : 'default',
                // True only when THIS scope has its own row (what reset removes).
                overridden: programId ? !!own : !!org,
                subject: row?.subject ?? null,
                body: row?.body ?? null,
                defaultSubject: fallback.subject,
                defaultBody: fallback.html,
                updatedAt: row?.updatedAt ?? null,
                updatedBy: row?.updatedById ? (editorName.get(row.updatedById) ?? null) : null,
              },
            ];
          }),
        ),
      })),
    }));
    return NextResponse.json({ groups, programs, limits: { subject: SUBJECT_MAX, body: BODY_MAX } });
  });
}

const putSchema = z.object({
  eventKey: z.string().min(1).max(96),
  locale: z.string().max(8),
  subject: z.string().max(SUBJECT_MAX),
  body: z.string().max(BODY_MAX),
  programId: z.string().min(1).max(64).optional(),
});

export async function PUT(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { eventKey, locale, subject, body } = parsed.data;
  const def = editableEvent(eventKey);
  if (!def || !isLocale(locale)) return NextResponse.json({ error: 'Unknown event or locale' }, { status: 400 });
  const refusal = checkTemplateDraft(def, { subject, body });
  if (refusal) return NextResponse.json({ error: 'Template would not be used', code: refusal }, { status: 400 });
  const orgId = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    const programId = await programScope(orgId, parsed.data.programId);
    if (programId === false) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await prisma.notificationTemplate.upsert({
      where: { orgId_programId_eventKey_locale: { orgId, programId, eventKey, locale } },
      create: { orgId, programId, eventKey, locale, subject, body, updatedById: session.user.id },
      update: { subject, body, updatedById: session.user.id },
    });
    await logActivity({
      action: 'notification_template.saved',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'NotificationTemplate',
      targetId: `${eventKey}:${locale}${programId ? `:${programId}` : ''}`,
      request,
      orgId,
    });
    return NextResponse.json({ ok: true });
  });
}

export async function DELETE(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const sp = new URL(request.url).searchParams;
  const eventKey = sp.get('eventKey') ?? '';
  const locale = sp.get('locale') ?? '';
  if (!editableEvent(eventKey) || !isLocale(locale)) return NextResponse.json({ error: 'Unknown event or locale' }, { status: 400 });
  const orgId = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    const programId = await programScope(orgId, sp.get('programId'));
    if (programId === false) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const res = await prisma.notificationTemplate.deleteMany({ where: { orgId, programId, eventKey, locale } });
    if (res.count > 0) {
      await logActivity({
        action: 'notification_template.reset',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        targetType: 'NotificationTemplate',
        targetId: `${eventKey}:${locale}${programId ? `:${programId}` : ''}`,
        request,
        orgId,
      });
    }
    return NextResponse.json({ ok: true, removed: res.count });
  });
}
