import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasConsent } from '@/lib/consent';
import { extractCvText } from '@/lib/cvParse';
import { isAiConfigured } from '@/lib/cvExtractAi';
import { aiCvFeedback } from '@/lib/aiCvFeedback';
import { runAiGated } from '@/lib/aiGate';
import { enforceRateLimit } from '@/lib/rateLimit';
import { AI_RATE_LIMITS } from '@/lib/ai/limits';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { hashInput, latestArtifact, toArtifactDto } from '@/lib/ai/artifacts';

// AI CV improvement feedback (Faz 2, #535) — the mentee's own CV only, and
// FREE for the mentee: the cost is metered against the org's AI quota via the
// central gate, and the mentee is never shown a paywall (quota exhaustion
// surfaces as "temporarily unavailable").

// GET — availability for the portal UI: the feature stays hidden unless the
// provider is configured AND a CV is uploaded; consent state drives the hint.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [cv, consent, latest] = await Promise.all([
    prisma.cvFile.findUnique({ where: { userId: session.user.id }, select: { id: true } }),
    hasConsent(session.user.id, 'AI_CV_PARSING'),
    // The last feedback (#2044) — survives a reload, shows when it was written.
    settingsOrgOf(session).then((orgId) => latestArtifact({ orgId, taskId: 'cv_feedback', subjectUserId: session.user.id })),
  ]);
  return NextResponse.json({ configured: isAiConfigured(), hasCv: !!cv, consent, latest: latest ? toArtifactDto(latest, session.user.id) : null });
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

  // `{ regenerate: true }` is the explicit Regenerate (#2044); no body is a normal ask.
  const regenerate = ((await request.json().catch(() => null)) as { regenerate?: unknown } | null)?.regenerate === true;
  const cv = await prisma.cvFile.findUnique({ where: { userId: session.user.id } });
  if (!cv) return NextResponse.json({ error: 'No CV uploaded' }, { status: 404 });

  let text = '';
  try {
    text = await extractCvText(Buffer.from(cv.data), cv.contentType);
  } catch {
    return NextResponse.json({ error: 'Could not read the CV file' }, { status: 422 });
  }
  if (!text.trim()) return NextResponse.json({ feedback: null, empty: true });

  const gated = await runAiGated({
    orgId: await settingsOrgOf(session),
    scope: 'cv_feedback',
    consent: { userId: session.user.id, type: 'AI_CV_PARSING' },
    userId: session.user.id,
    call: () => aiCvFeedback(text),
    // Kept (#2044): the same CV text inside the TTL is answered from the
    // stored feedback — no provider call, no quota — unless Regenerate asks.
    persist: {
      subjectUserId: session.user.id,
      createdById: session.user.id,
      inputHash: hashInput({ text }),
      force: regenerate,
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
  return NextResponse.json({ feedback: gated.result, cached: gated.cached ?? false, artifact: gated.artifact ?? null });
}
