import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { defaultOrgId } from '@/lib/defaultOrg';
import { requireCapability } from '@/lib/capabilityGate';
import { resolveRequestVertical } from '@/i18n/server';
import { verticalHasCapability } from '@/lib/verticals';
import { activeForms, publicForm } from '@/lib/forms/active';

// GET — the REGISTRATION questions of a PUBLIC form (#1803), for a visitor who
// has no account yet, so there is no session to take the org from: the org
// comes from the link.
//   ?for=apply&mentorId=…    the per-mentor apply link — the mentor's org,
//                            mentee questions; an unknown or closed-org link 404s
//   ?for=mentor-application  the become-a-mentor form — the default org,
//                            mentor questions
// Questions only: never an answer, never `matchable`. The same questions are
// shown to every visitor of that public page, so there is nothing per-caller here.

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const kind = sp.get('for');
  if (kind === 'apply') {
    const mentor = await prisma.user.findFirst({
      where: { id: sp.get('mentorId') || '', role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
      select: { orgId: true },
    });
    if (!mentor || (await requireCapability(mentor.orgId, 'mentorship'))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ forms: (await activeForms(mentor.orgId, 'REGISTRATION', 'MENTEE')).map(publicForm) });
  }
  if (kind === 'mentor-application') {
    if (!verticalHasCapability(await resolveRequestVertical(), 'mentorship')) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ forms: (await activeForms(await defaultOrgId(), 'REGISTRATION', 'MENTOR')).map(publicForm) });
  }
  return NextResponse.json({ error: 'Invalid form', code: 'invalid_form' }, { status: 400 });
}
