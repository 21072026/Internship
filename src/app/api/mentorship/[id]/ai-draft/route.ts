import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireRoleOrPermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { withRequestScope } from '@/lib/requestContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { runAiGated } from '@/lib/aiGate';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { locales, type Locale } from '@/i18n/config';
import { aiDraftOutreach, type Draft } from '@/lib/aiOutreach';
import { loadOutreachFacts, outreachDraftHash } from '@/lib/outreachFacts';
import { OUTREACH_MOMENTS, pickMoment } from '@/lib/outreachRules';
import { threadAiRefusal } from '@/lib/threadAiResponses';

// POST — a grounded draft for one mentee (#2048, part 2): the first message,
// the check-in to a quiet mentee, or the note on an outcome stage — `auto`
// picks the moment from the relation's own state. The mentor of the pair (or
// an admin of its org) only, the mentee's AI_INTERACTION_SUMMARY consent
// gates it, and the draft is written in the MENTEE's language.
//
// It returns text and nothing else. No message, mail or log row is created
// here; the composer shows the draft and the mentor presses Send. Free, never
// plan-gated. The same relation state is answered from the stored draft.

const schema = z.object({ moment: z.enum([...OUTREACH_MOMENTS, 'auto']).optional(), regenerate: z.boolean().optional() }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withRequestScope(request, () => handlePost(request, params));
}

async function handlePost(request: Request, params: Promise<{ id: string }>) {
  const gate = await requireRoleOrPermission(['MENTOR'], 'relation.write', { request });
  if ('error' in gate) return gate.error;
  const { session, admin } = gate;
  const limited = enforceRateLimit(request, 'ai:outreach_draft', { ...AI_RATE_LIMITS.outreach_draft, subject: session.user.id });
  if (limited) return limited;
  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', { ...AI_RATE_LIMITS.org_burst, subject: session.user.orgId });
    if (orgLimited) return orgLimited;
  }
  const { id } = await params;
  const parsed = schema.safeParse((await request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
    const rel = await prisma.mentorshipRelation.findUnique({
      where: { id },
      select: {
        id: true, orgId: true, mentorId: true, menteeId: true, pipelineStatus: true, dormantSince: true,
        mentor: { select: { fullName: true } },
        mentee: { select: { fullName: true, preferredLanguage: true } },
      },
    });
    // The mentor of the pair, or an admin of its org; anything else reads as missing.
    const allowed = rel && (admin ? await inCallerTenant(rel.orgId, resolveOrgId(session)) : rel.mentorId === session.user.id);
    if (!rel || !allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const locale: Locale = (locales as readonly string[]).includes(rel.mentee.preferredLanguage ?? '') ? (rel.mentee.preferredLanguage as Locale) : 'en';
    const facts = await loadOutreachFacts(rel, { id: session.user.id, role: session.user.role }, locale);
    const moment = !parsed.data.moment || parsed.data.moment === 'auto' ? pickMoment(facts) : parsed.data.moment;

    const gated = await runAiGated<Draft>({
      orgId: await settingsOrgOf(session),
      scope: 'outreach_draft',
      consent: { userId: rel.menteeId, type: 'AI_INTERACTION_SUMMARY' },
      userId: session.user.id,
      call: () => aiDraftOutreach({ moment, facts, locale, mentorName: rel.mentor.fullName }),
      persist: {
        subjectUserId: rel.menteeId,
        createdById: session.user.id,
        relationId: rel.id,
        inputHash: outreachDraftHash(rel.id, session.user.id, moment, locale, facts),
        force: parsed.data.regenerate,
        serialize: (d) => JSON.stringify(d),
        deserialize: (c) => JSON.parse(c) as Draft,
      },
    });
    if (!gated.ok) return threadAiRefusal(gated.reason);
    return NextResponse.json({ moment, locale, draft: gated.result, cached: !!gated.cached });
  });
}

