import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canAccessCv } from '@/lib/cvAccess';
import { resolveOrgId } from '@/lib/orgScope';
import { userInCallerOrg } from '@/lib/ownerOrg';
import { extractCvText, suggestFromText } from '@/lib/cvParse';

// GET — derive high-precision profile suggestions from the stored CV (EPIC B1).
// Local parsing only; no external calls. Access-controlled like the CV download.
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { userId } = await params;
  const target = userId === 'me' ? session.user.id : userId;
  // Another org's user is 404, before the access check (#2542).
  if (!(await userInCallerOrg(target, resolveOrgId(session)))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
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
  if (!text.trim()) {
    return NextResponse.json({ suggestions: { skills: [] }, empty: true });
  }

  return NextResponse.json({ suggestions: suggestFromText(text) });
}
