import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { getSetting, setSetting } from '@/lib/settings';
import { logActivity } from '@/lib/activity';
import {
  MESSAGE_RETENTION_FLOOR_DAYS,
  WATCH_KEYWORD_LIMITS,
  parseWatchKeywords,
  serializeWatchKeywords,
} from '@/lib/safeguarding';

// The org's safeguarding settings (#2056): the watch list and the message
// retention window. Both are ordinary per-tenant settings (src/lib/settings.ts)
// — no second settings mechanism — written to the CALLER's org row only,
// never the global one (#2628). ADMIN only, checked here.

async function read(orgId: string) {
  const [keywords, days] = await Promise.all([
    getSetting('safeguardingKeywords', orgId),
    getSetting('messageRetentionDays', orgId),
  ]);
  const parsedDays = Number.parseInt(days, 10);
  return {
    keywords: parseWatchKeywords(keywords),
    messageRetentionDays: Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 0,
    limits: { ...WATCH_KEYWORD_LIMITS, retentionFloorDays: MESSAGE_RETENTION_FLOOR_DAYS },
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const orgId = await settingsOrgOf(session);
  return withTenantScope(session, async () => NextResponse.json(await read(orgId)));
}

const schema = z.object({
  keywords: z
    .array(z.string().max(WATCH_KEYWORD_LIMITS.maxLength))
    .max(WATCH_KEYWORD_LIMITS.maxKeywords * 2)
    .optional(),
  // 0 = keep forever. Four digits ≈ 27 years; the sweep raises 1..29 to 30.
  messageRetentionDays: z.number().int().min(0).max(9999).optional(),
});

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const orgId = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    const changed: string[] = [];
    if (parsed.data.keywords) {
      await setSetting('safeguardingKeywords', serializeWatchKeywords(parsed.data.keywords), orgId);
      changed.push(`keywords=${parseWatchKeywords(parsed.data.keywords.join('\n')).length}`);
    }
    if (parsed.data.messageRetentionDays !== undefined) {
      await setSetting('messageRetentionDays', String(parsed.data.messageRetentionDays), orgId);
      changed.push(`messageRetentionDays=${parsed.data.messageRetentionDays}`);
    }
    if (changed.length > 0) {
      // The count, never the words: a watch list can itself be sensitive.
      await logActivity({
        action: 'safeguarding.settings',
        actorId: session.user.id,
        actorEmail: session.user.email ?? null,
        detail: changed.join(' '),
        request,
        orgId,
      });
    }
    return NextResponse.json(await read(orgId));
  });
}
