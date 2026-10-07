import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getThreadIfAllowed } from '@/lib/messaging';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { AI_PACK_FEATURE, runAiGated } from '@/lib/aiGate';
import { aiSummarizeInteractions } from '@/lib/aiSummary';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { entitled } from '@/lib/entitlements';
import { hashInput, latestArtifact, toArtifactDto } from '@/lib/ai/artifacts';

const schema = z.object({
  relationId: z.string().min(1),
  // The explicit Regenerate: skip the stored summary of the same log (#2044).
  regenerate: z.boolean().optional(),
});

// GET ?relationId= — the relation's last summary (#2044), so a reload or next
// month's visit opens on it instead of an empty card. Same gate as POST: the
// mentor of the pair or an admin of its org; anything else reads as missing.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const relationId = new URL(request.url).searchParams.get('relationId') ?? '';
  if (!relationId) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  return await withTenantScope(session, async () => {
    const rel = await getThreadIfAllowed(session.user, relationId);
    if (!rel || !(await inCallerTenant(rel.orgId, resolveOrgId(session)))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // An admin on a pair that is not theirs reads the summary as an operator
    // tool (#1738): without the pack there is no stored copy to open either.
    const orgId = await settingsOrgOf(session);
    if (isOperatorUse(session.user, rel.mentorId) && !(await entitled(orgId, AI_PACK_FEATURE))) {
      return NextResponse.json({ latest: null, locked: true });
    }
    const latest = await latestArtifact({ orgId, taskId: 'interaction_summary', subjectUserId: rel.menteeId, relationId: rel.id });
    return NextResponse.json({ latest: latest ? toArtifactDto(latest, session.user.id) : null });
  });
}

// POST — AI auto-summary of a relation's interaction logs (Faz 2, #534).
// Mentor/admin only (it is a mentor-facing digest of their own log). Runs
// through the central AI gate: the MENTEE's AI_INTERACTION_SUMMARY consent →
// monthly quota → provider. Only log text is sent, never files/contact data.
//
// Audience (#1738): the task is `participant` — the pair's own mentor reading
// their own log is the free core and never meets the AI pack. An ADMIN
// summarising a pair that is not theirs is using it as an admin tool, so that
// call is escalated to operator and, without the pack, answers the shared
// 403 feature_locked like every other operator route.

/** Staff reading a pair that is not theirs — the one caller the pack applies to. */
function isOperatorUse(user: { id: string; role: string }, mentorId: string): boolean {
  return user.role === 'ADMIN' && user.id !== mentorId;
}
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const userLimited = enforceRateLimit(request, 'ai:interaction_summary', {
    ...AI_RATE_LIMITS.interaction_summary,
    subject: session.user.id,
  });
  if (userLimited) return userLimited;

  if (session.user.orgId) {
    const orgLimited = enforceRateLimit(request, 'ai:org', {
      ...AI_RATE_LIMITS.org_burst,
      subject: session.user.orgId,
    });
    if (orgLimited) return orgLimited;
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  return await withTenantScope(session, async () => {
  // getThreadIfAllowed lets any ADMIN through; another tenant's relation must
  // answer exactly like a missing one, before a single log is read or sent to
  // the AI provider (#2542).
  const rel = await getThreadIfAllowed(session.user, parsed.data.relationId);
  if (!rel || !(await inCallerTenant(rel.orgId, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const interactions = await prisma.interactionLog.findMany({
    where: { relationId: rel.id },
    orderBy: { date: 'desc' },
    take: 30,
    select: { date: true, type: true, subject: true, notes: true },
  });
  if (interactions.length === 0) return NextResponse.json({ summary: null, empty: true });

  const gated = await runAiGated({
    orgId: await settingsOrgOf(session),
    scope: 'interaction_summary',
    ...(isOperatorUse(session.user, rel.mentorId) ? { audience: 'operator' as const } : {}),
    // The mentee's data is being processed — their consent gates the call.
    consent: { userId: rel.menteeId, type: 'AI_INTERACTION_SUMMARY' },
    userId: session.user.id,
    call: () => aiSummarizeInteractions(rel.mentee.fullName, interactions),
    // Kept (#2044): the same log — not one entry added or edited — inside the
    // TTL is answered from the stored summary, with no provider call and no
    // quota. The summary is about the mentee, so it is erased with them.
    persist: {
      subjectUserId: rel.menteeId,
      createdById: session.user.id,
      relationId: rel.id,
      inputHash: hashInput({
        relationId: rel.id,
        mentee: rel.mentee.fullName,
        log: interactions.map((i) => ({ date: i.date.toISOString(), type: i.type, subject: i.subject ?? '', notes: i.notes })),
      }),
      force: parsed.data.regenerate,
    },
  });

  if (!gated.ok) {
    if (gated.reason === 'no_consent') {
      return NextResponse.json({ error: 'Mentee consent required', code: 'consent_required' }, { status: 403 });
    }
    if (gated.reason === 'not_entitled') {
      return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: AI_PACK_FEATURE }, { status: 403 });
    }
    if (gated.reason === 'quota_exceeded') {
      return NextResponse.json({ error: 'Monthly AI quota exhausted', code: 'quota_exceeded' }, { status: 429 });
    }
    // The provider failed even after its retries (#2024): the same neutral
    // "not right now" — never a paywall, never a stack trace.
    if (gated.reason === 'provider_error') {
      return NextResponse.json({ error: 'Temporarily unavailable', code: 'provider_error' }, { status: 503 });
    }
    return NextResponse.json({ error: 'AI is not configured', code: 'not_configured' }, { status: 501 });
  }
  return NextResponse.json({ summary: gated.result, cached: !!gated.cached, artifact: gated.artifact ?? null });
  });
}
