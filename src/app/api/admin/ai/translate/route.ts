import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { AI_PACK_FEATURE, runAiGated } from '@/lib/aiGate';
import { translateContent } from '@/lib/ai/translate';
import { locales } from '@/i18n/config';
import { TRANSLATION_PURPOSES, type LocaleMap } from '@/lib/machineTranslation';

// POST — fill the empty locales of one tenant-authored text (#2055): the
// admin's announcement, goal template or message template, translated from the
// locale they wrote into the ones they left empty. ADMIN only, checked here.
// Returns the translations and nothing else — nothing is saved, published or
// sent; the editor shows them marked "machine-translated" until the admin
// edits or confirms each one. The client sends only the empty locales, and
// mergeMachine (src/lib/machineTranslation.ts) refuses to overwrite a filled
// one even if it did not.

const schema = z
  .object({
    purpose: z.enum(TRANSLATION_PURPOSES),
    from: z.enum(locales),
    text: z.string().trim().min(1).max(20_000),
    to: z.array(z.enum(locales)).min(1).max(locales.length),
  })
  .strict();

export async function POST(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const limited = enforceRateLimit(request, 'ai:content_translate', { ...AI_RATE_LIMITS.content_translate, subject: session.user.id });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const { purpose, from, text, to } = parsed.data;

  return await withTenantScope(session, async () => {
    const gated = await runAiGated<LocaleMap>({
      orgId: await settingsOrgOf(session),
      scope: 'content_translate',
      userId: session.user.id,
      call: () => translateContent({ text, from, to: to.filter((l) => l !== from), purpose }),
    });
    if (!gated.ok) {
      // An operator task without the AI pack (#1738): the shared locked shape.
      if (gated.reason === 'not_entitled') return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: AI_PACK_FEATURE }, { status: 403 });
      const status = gated.reason === 'not_configured' ? 501 : gated.reason === 'quota_exceeded' ? 429 : gated.reason === 'disabled' ? 403 : 503;
      return NextResponse.json({ error: 'Translation is not available right now', code: gated.reason }, { status });
    }
    return NextResponse.json({ translations: gated.result });
  });
}
