import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasConsent } from '@/lib/consent';
import { extractCvText } from '@/lib/cvParse';
import { isAiConfigured } from '@/lib/ai/provider';
import { aiCvFeedback } from '@/lib/aiCvFeedback';
import { runAiGated } from '@/lib/aiGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hashInput, latestArtifact, toArtifactDto } from '@/lib/ai/artifacts';
import { previousScore, tailorableRoles, tailoringTarget } from '@/lib/cvReview';
import type { CvReview } from '@/lib/cvReviewRules';

// AI CV improvement feedback (Faz 2, #535) — the mentee's own CV only, and
// FREE for the mentee: the cost is metered against the org's AI quota via the
// central gate, and the mentee is never shown a paywall (quota exhaustion
// surfaces as "temporarily unavailable").

// GET — the card's state: availability, consent, the roles the mentee may
// tailor to, and the last review (#2044) with the score before it (#2050),
// so a re-upload shows the delta. A stored review is shown even when the
// provider is not configured — reading it costs nothing.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = await settingsOrgOf(session);
  const [cv, consent, latest, roles] = await Promise.all([
    prisma.cvFile.findUnique({ where: { userId: session.user.id }, select: { id: true } }),
    hasConsent(session.user.id, 'AI_CV_PARSING'),
    latestArtifact({ orgId, taskId: 'cv_feedback', subjectUserId: session.user.id }),
    tailorableRoles(session.user.id),
  ]);
  const previous = latest ? await previousScore({ orgId, subjectUserId: session.user.id, requisitionId: latest.requisitionId, before: latest.createdAt }) : null;
  return NextResponse.json({ configured: isAiConfigured(), hasCv: !!cv, consent, roles, latest: latest ? toArtifactDto(latest, session.user.id) : null, previousScore: previous });
}

// POST — generate feedback for the caller's own uploaded CV.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userLimited = enforceRateLimit(request, 'ai:cv_feedback', {
    ...AI_RATE_LIMITS.cv_feedback,
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

  // `{ regenerate: true }` is the explicit Regenerate (#2044); `requisitionId`
  // tailors the review to a role the mentee is connected to (#2050).
  const body = ((await request.json().catch(() => null)) ?? {}) as { regenerate?: unknown; requisitionId?: unknown };
  const regenerate = body.regenerate === true;
  const requisitionId = typeof body.requisitionId === 'string' && body.requisitionId ? body.requisitionId : null;
  const cv = await prisma.cvFile.findUnique({ where: { userId: session.user.id } });
  if (!cv) return NextResponse.json({ error: 'No CV uploaded' }, { status: 404 });

  let text = '';
  try {
    text = await extractCvText(Buffer.from(cv.data), cv.contentType);
  } catch {
    return NextResponse.json({ error: 'Could not read the CV file' }, { status: 422 });
  }
  if (!text.trim()) return NextResponse.json({ feedback: null, empty: true });
  const target = requisitionId ? await tailoringTarget(session.user.id, requisitionId, text) : null;
  // A role the mentee is not connected to reads as missing — never a probe of what a company hires for.
  if (requisitionId && !target) return NextResponse.json({ error: 'Role not found', code: 'role_not_found' }, { status: 404 });
  const orgId = await settingsOrgOf(session);

  const gated = await runAiGated<CvReview | null>({
    orgId,
    scope: 'cv_feedback',
    consent: { userId: session.user.id, type: 'AI_CV_PARSING' },
    userId: session.user.id,
    call: () => aiCvFeedback(text, target),
    // Kept (#2044): the same CV text for the same target inside the TTL is
    // answered from the stored review — no provider call, no quota — unless
    // Regenerate asks. Stored as JSON; the prose stored before #2050 still
    // reads back (readStoredFeedback).
    persist: {
      subjectUserId: session.user.id,
      createdById: session.user.id,
      requisitionId: target?.id ?? null,
      inputHash: hashInput({ text, requisitionId: target?.id ?? null }),
      force: regenerate,
      serialize: (r) => JSON.stringify(r),
      deserialize: (c) => JSON.parse(c) as CvReview,
    },
  });

  if (!gated.ok) {
    if (gated.reason === 'no_consent') {
      return NextResponse.json({ error: 'Consent required', code: 'consent_required' }, { status: 403 });
    }
    if (gated.reason === 'quota_exceeded') {
      // Never a paywall for the mentee — just "not right now".
      return NextResponse.json({ error: 'Temporarily unavailable', code: 'quota_exceeded' }, { status: 429 });
    }
    // The provider failed even after its retries (#2024): the same neutral
    // "not right now" — never a paywall, never a stack trace.
    if (gated.reason === 'provider_error') {
      return NextResponse.json({ error: 'Temporarily unavailable', code: 'provider_error' }, { status: 503 });
    }
    return NextResponse.json({ error: 'AI is not configured', code: 'not_configured' }, { status: 501 });
  }
  // Not the JSON asked for (#2024): metered parse_error, nothing stored, and the same neutral answer.
  if (!gated.result) return NextResponse.json({ error: 'Temporarily unavailable', code: 'provider_error' }, { status: 503 });
  const previous = gated.artifact
    ? await previousScore({ orgId, subjectUserId: session.user.id, requisitionId: target?.id ?? null, before: new Date(gated.artifact.createdAt) })
    : null;
  return NextResponse.json({ review: gated.result, previousScore: previous, cached: gated.cached ?? false, artifact: gated.artifact ?? null });
}
