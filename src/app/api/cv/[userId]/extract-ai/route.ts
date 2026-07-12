import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessCv } from '@/lib/cvAccess';
import { extractCvText } from '@/lib/cvParse';
import { aiExtractFromText } from '@/lib/cvExtractAi';
import { runAiGated } from '@/lib/aiGate';

// POST — AI-assisted extraction of profile fields from the stored CV (EPIC B3).
// Runs through the central AI gate (#537): CV-owner consent → configured
// provider → monthly quota → call (metered). Only the extracted TEXT is sent
// to the AI provider, never the file.
export async function POST(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await params;
  const target = userId === 'me' ? session.user.id : userId;
  if (!(await canAccessCv(session.user, target))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const cv = await prisma.cvFile.findUnique({ where: { userId: target } });
  if (!cv) return NextResponse.json({ error: 'No CV uploaded' }, { status: 404 });

  let text = '';
  try {
    text = await extractCvText(Buffer.from(cv.data), cv.contentType);
  } catch {
    return NextResponse.json({ error: 'Could not read the CV file' }, { status: 422 });
  }
  if (!text.trim()) return NextResponse.json({ suggestions: null, empty: true });

  try {
    const gated = await runAiGated({
      scope: 'cv_extract',
      // The consent belongs to the CV owner (the person whose data is processed).
      consent: { userId: target, type: 'AI_CV_PARSING' },
      userId: session.user.id,
      call: () => aiExtractFromText(text),
    });
    if (!gated.ok) {
      if (gated.reason === 'no_consent') {
        return NextResponse.json({ error: 'Consent required', code: 'consent_required' }, { status: 403 });
      }
      if (gated.reason === 'quota_exceeded') {
        return NextResponse.json({ error: 'Monthly AI quota exhausted', code: 'quota_exceeded' }, { status: 429 });
      }
      return NextResponse.json({ error: 'AI extraction is not configured', code: 'not_configured' }, { status: 501 });
    }
    return NextResponse.json({ suggestions: gated.result });
  } catch (e) {
    console.error('AI CV extract error:', e);
    return NextResponse.json({ error: 'AI extraction failed' }, { status: 502 });
  }
}
