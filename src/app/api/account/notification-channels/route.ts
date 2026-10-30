import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { logActivity } from '@/lib/activity';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@/lib/notificationPrefs';
import { NOTIFICATION_EVENTS } from '@/lib/notifications/catalog';
import { isEssentialGroup } from '@/lib/emailGroups';
import {
  MATRIX_CHANNELS,
  isValidTimeZone,
  readChannelMap,
  readQuietHours,
  type MatrixChannel,
} from '@/lib/notificationChannelPrefs';

// The channel matrix and quiet hours (#1714) — docs/notification-channels.md.
// Stored inside `User.notificationPrefs` next to the category switches; this
// route MERGES into that JSON and never touches the boolean keys, so it cannot
// resurrect a category somebody switched off (the same rule applyUnsubscribe.ts
// keeps for the e-mail groups).

/** Categories with at least one non-essential event — the only ones push can be added to. */
function routedCategories(): Set<string> {
  return new Set(NOTIFICATION_EVENTS.filter((e) => !isEssentialGroup(e.emailGroup)).map((e) => e.category));
}

/** Which matrix channels any non-essential event of the category uses by default. */
function categoryDefaults(): Record<NotificationCategory, Record<MatrixChannel, boolean>> {
  const out = Object.fromEntries(
    NOTIFICATION_CATEGORIES.map((c) => [c, { inApp: false, email: false, push: false }]),
  ) as Record<NotificationCategory, Record<MatrixChannel, boolean>>;
  for (const e of NOTIFICATION_EVENTS) {
    if (isEssentialGroup(e.emailGroup)) continue;
    for (const ch of MATRIX_CHANNELS) if ((e.defaultChannels as readonly string[]).includes(ch)) out[e.category][ch] = true;
  }
  return out;
}

function prefsObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function view(prefs: unknown, timezone: string | null) {
  const map = readChannelMap(prefs, NOTIFICATION_CATEGORIES);
  const defaults = categoryDefaults();
  const routed = routedCategories();
  return {
    categories: NOTIFICATION_CATEGORIES.map((id) => ({
      id,
      channels: MATRIX_CHANNELS.map((ch) => ({
        channel: ch,
        default: defaults[id][ch],
        // null = follows the default; e-mail can be taken away, never added.
        value: map[id]?.[ch] ?? null,
        settable: defaults[id][ch] || (ch === 'push' && routed.has(id)),
      })),
    })),
    quietHours: readQuietHours(prefs),
    timezone: isValidTimeZone(timezone) ? timezone : null,
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { notificationPrefs: true, timezone: true },
    });
    if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(view(user.notificationPrefs, user.timezone));
  });
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);
const channelRow = z
  .object({ inApp: z.boolean().nullable(), email: z.boolean().nullable(), push: z.boolean().nullable() })
  .partial()
  .strict();
const schema = z
  .object({
    // Sparse: a category or channel absent from the body is left as it is;
    // `null` clears an override back to the catalogue default.
    channels: z.record(z.enum(NOTIFICATION_CATEGORIES), channelRow).optional(),
    quietHours: z
      .object({ start: HHMM, end: HHMM, tz: z.string().max(64).optional() })
      .strict()
      .refine((q) => q.start !== q.end, { message: 'start and end must differ' })
      .refine((q) => q.tz === undefined || isValidTimeZone(q.tz), { message: 'unknown time zone' })
      .nullable()
      .optional(),
  })
  .strict();

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // Same rule as the category switches: an admin inside an impersonation
  // session does not decide what reaches the account holder's phone.
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot change notification settings while impersonating' }, { status: 400 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input', code: 'invalid_input', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;
  const defaults = categoryDefaults();
  const routed = routedCategories();
  if (body.channels) {
    for (const [cat, row] of Object.entries(body.channels)) {
      // E-mail is only ever taken away: a category that mails nobody by design
      // cannot be switched on here (resolveChannels would ignore it anyway).
      if (row.email === true && !defaults[cat as NotificationCategory].email) {
        return NextResponse.json({ error: 'This category sends no e-mail', code: 'channel_not_settable' }, { status: 400 });
      }
      if (row.push === true && !routed.has(cat)) {
        return NextResponse.json({ error: 'This category raises no notifications here', code: 'channel_not_settable' }, { status: 400 });
      }
      if (row.inApp === true && !defaults[cat as NotificationCategory].inApp) {
        return NextResponse.json({ error: 'This category has no in-app notice', code: 'channel_not_settable' }, { status: 400 });
      }
    }
  }

  return await withTenantScope(session, async () => {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: session.user.id },
        select: { notificationPrefs: true, timezone: true },
      });
      if (!user) return null;
      const prefs = prefsObject(user.notificationPrefs);
      if (body.channels) {
        const map = readChannelMap(prefs, NOTIFICATION_CATEGORIES) as Record<string, Partial<Record<MatrixChannel, boolean>>>;
        for (const [cat, row] of Object.entries(body.channels)) {
          const next = { ...(map[cat] ?? {}) };
          for (const ch of MATRIX_CHANNELS) {
            const v = row[ch];
            if (v === undefined) continue;
            if (v === null) delete next[ch];
            else next[ch] = v;
          }
          if (Object.keys(next).length) map[cat] = next;
          else delete map[cat];
        }
        if (Object.keys(map).length) prefs.channels = map;
        else delete prefs.channels;
      }
      if (body.quietHours !== undefined) {
        if (body.quietHours === null) delete prefs.quietHours;
        else prefs.quietHours = body.quietHours;
      }
      const updated = await tx.user.update({
        where: { id: session.user.id },
        data: { notificationPrefs: prefs as object },
        select: { notificationPrefs: true, timezone: true },
      });
      return updated;
    });
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Keys only, never values beyond on/off — ActivityLog.detail is 191 chars.
    const touched = [
      ...Object.keys(body.channels ?? {}).map((c) => `channels.${c}`),
      ...(body.quietHours !== undefined ? ['quietHours'] : []),
    ];
    await logActivity({
      action: 'notifications.channels',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: session.user.id,
      detail: touched.join(',').slice(0, 180) || null,
      request,
    });
    return NextResponse.json(view(result.notificationPrefs, result.timezone));
  });
}
