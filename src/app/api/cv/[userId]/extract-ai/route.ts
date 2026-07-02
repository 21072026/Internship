import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessCv } from '@/lib/cvAccess';
import { hasConsent } from '@/lib/consent';
import { extractCvText } from '@/lib/cvParse';
import { aiExtractFromText, isAiConfigured } from '@/lib/cvExtractAi';

// POST — AI-assisted extraction of profile fields from the stored CV (EPIC B3).
// Requires: CV access + active AI_CV_PARSING consent + a configured API key.
// Only the extracted TEXT is sent to the AI provider, never the file.
export async function POST(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await params;
  const target = userId === 'me' ? session.user.id : userId;
  if (!(await canAccessCv(session.user, target))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // The consent belongs to the CV owner (the person whose data is processed).
  if (!(await hasConsent(target, 'AI_CV_PARSING'))) {
    return NextResponse.json({ error: 'Consent required', code: 'consent_required' }, { status: 403 });
  }
  if (!isAiConfigured()) {
    return NextResponse.json({ error: 'AI extraction is not configured', code: 'not_configured' }, { status: 501 });
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
    const suggestions = await aiExtractFromText(text);
    return NextResponse.json({ suggestions });
  } catch (e) {
    console.error('AI CV extract error:', e);
    return NextResponse.json({ error: 'AI extraction failed' }, { status: 502 });
  }
}
