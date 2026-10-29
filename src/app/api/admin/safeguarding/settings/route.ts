import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { writeSetting } from '@/lib/settingsWrite';
import { resolveSettingRaw } from '@/lib/settingsResolver';
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
    resolveSettingRaw('safeguardingKeywords', { orgId }),
    resolveSettingRaw('messageRetentionDays', { orgId }),
  ]);
  const parsedDays = Number.parseInt(days, 10);
  return {
    keywords: parseWatchKeywords(keywords),
    messageRetentionDays: Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 0,
    limits: { ...WATCH_KEYWORD_LIMITS, retentionFloorDays: MESSAGE_RETENTION_FLOOR_DAYS },
  };
}

export async function GET(request: Request) {
  const gate = await requirePermission('safeguarding.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
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
  const gate = await requirePermission('safeguarding.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const orgId = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    const changed: string[] = [];
    if (parsed.data.keywords) {
      await writeSetting('safeguardingKeywords', serializeWatchKeywords(parsed.data.keywords), orgId, { actor: { id: session.user.id, email: session.user.email } });
      changed.push(`keywords=${parseWatchKeywords(parsed.data.keywords.join('\n')).length}`);
    }
    if (parsed.data.messageRetentionDays !== undefined) {
      await writeSetting('messageRetentionDays', String(parsed.data.messageRetentionDays), orgId, { actor: { id: session.user.id, email: session.user.email } });
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
