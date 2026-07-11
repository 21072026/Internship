import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { hasConsent } from '@/lib/consent';
import { extractCvText } from '@/lib/cvParse';
import { isAiConfigured } from '@/lib/cvExtractAi';
import { aiCvFeedback } from '@/lib/aiCvFeedback';
import { runAiGated } from '@/lib/aiGate';

// AI CV improvement feedback (Faz 2, #535) — the mentee's own CV only, and
// FREE for the mentee: the cost is metered against the org's AI quota via the
// central gate, and the mentee is never shown a paywall (quota exhaustion
// surfaces as "temporarily unavailable").

// GET — availability for the portal UI: the feature stays hidden unless the
// provider is configured AND a CV is uploaded; consent state drives the hint.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [cv, consent] = await Promise.all([
    prisma.cvFile.findUnique({ where: { userId: session.user.id }, select: { id: true } }),
    hasConsent(session.user.id, 'AI_CV_PARSING'),
  ]);
  return NextResponse.json({ configured: isAiConfigured(), hasCv: !!cv, consent });
}

// POST — generate feedback for the caller's own uploaded CV.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
    scope: 'cv_feedback',
    consent: { userId: session.user.id, type: 'AI_CV_PARSING' },
    userId: session.user.id,
    call: () => aiCvFeedback(text),
  });

  if (!gated.ok) {
    if (gated.reason === 'no_consent') {
      return NextResponse.json({ error: 'Consent required', code: 'consent_required' }, { status: 403 });
    }
    if (gated.reason === 'quota_exceeded') {
      // Never a paywall for the mentee — just "not right now".
      return NextResponse.json({ error: 'Temporarily unavailable', code: 'quota_exceeded' }, { status: 429 });
    }
    return NextResponse.json({ error: 'AI is not configured', code: 'not_configured' }, { status: 501 });
  }
  return NextResponse.json({ feedback: gated.result });
}
