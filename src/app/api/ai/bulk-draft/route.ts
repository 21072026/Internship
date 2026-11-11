import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRoleOrPermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { locales } from '@/i18n/config';
import { aiDraftBulk, type Draft } from '@/lib/aiOutreach';
import { BULK_DRAFT_COST_CALLS, BULK_DRAFT_MAX_RECIPIENTS, BULK_PURPOSE_MAX, bulkRefusal } from '@/lib/outreachRules';
import { threadAiRefusal } from '@/lib/threadAiResponses';

// POST — ONE draft for the targeted bulk e-mail (#2048, part 2): a single
// provider call, personalised per recipient by the `{name}` merge field the
// send route already fills — never one call per recipient. The composer states
// the recipient count and the cost (one AI credit) before the button is
// pressed; above BULK_DRAFT_MAX_RECIPIENTS the request is refused before any
// call. Reads only the sender's own purpose text, so no consent is involved.
//
// Returns text; the send route (/api/mentor/email) is the only door out, and a
// person presses it. Free for mentors, never plan-gated.

const schema = z.object({
  purpose: z.string().trim().min(3).max(BULK_PURPOSE_MAX),
  recipientCount: z.number().int(),
  locale: z.enum(locales),
}).strict();

export async function POST(request: Request) {
  return withRequestScope(request, () => handlePost(request));
}

async function handlePost(request: Request) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'content.write', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  const limited = enforceRateLimit(request, 'ai:bulk_draft', { ...AI_RATE_LIMITS.bulk_draft, subject: session.user.id });
  if (limited) return limited;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  const refusal = bulkRefusal(parsed.data.recipientCount);
  if (refusal) {
    return NextResponse.json({ error: 'Too many recipients for one AI draft', code: refusal, max: BULK_DRAFT_MAX_RECIPIENTS }, { status: 400 });
  }

  return await withTenantScope(session, async () => {
    const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { fullName: true } });
    const gated = await runAiGated<Draft>({
      orgId: await settingsOrgOf(session),
      scope: 'bulk_draft',
      // A mentor drafting to their own mentees is the free core; an ADMIN's
      // bulk draft is an admin tool and needs the AI pack (#1738).
      ...(admin ? { audience: 'operator' as const } : {}),
      userId: session.user.id,
      call: () => aiDraftBulk({ purpose: parsed.data.purpose, locale: parsed.data.locale, authorName: me?.fullName ?? '', recipientCount: parsed.data.recipientCount }),
    });
    if (!gated.ok) return threadAiRefusal(gated.reason);
    return NextResponse.json({ draft: gated.result, cost: BULK_DRAFT_COST_CALLS });
  });
}
