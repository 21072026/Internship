import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { DEFAULT_TERMS_KEY, acceptTerms, acceptanceHistory, getActiveTerms, hasAcceptedContributorTerms } from '@/lib/contributorTerms';
import { prisma } from '@/lib/prisma';
import { isProjectMember } from '@/lib/projectTeam';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';

// GET — the terms in force plus this user's own acceptance state (#1025).
// The BODY is returned, not a link: the text has to be readable before the
// click for the acceptance to mean anything.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const locale = url.searchParams.get('locale') || 'en';
  const key = url.searchParams.get('key') || undefined;

  const terms = await getActiveTerms(key, locale);
  const [accepted, history] = await Promise.all([
    hasAcceptedContributorTerms(session.user.id, { termsKey: key }),
    acceptanceHistory(session.user.id),
  ]);

  return NextResponse.json({ terms, accepted, history });
}

const schema = z.object({
  key: z.string().min(1).max(60).optional(),
  projectId: z.string().min(1).optional().nullable(),
  // The client must send the version it displayed. If the text has been
  // superseded between render and click, we refuse rather than record consent
  // to a version the person never saw.
  version: z.string().min(1).max(20),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }

  // A project-scoped acceptance has to be about a project this person is
  // actually on, under the terms that project actually names (#1026). Without
  // this an acceptance row could be minted for any projectId and any key —
  // evidence that says nothing, which is worse than no evidence.
  let key = parsed.data.key;
  if (parsed.data.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
      select: { contributorTermsKey: true, contributorTermsRequired: true },
    });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!project.contributorTermsRequired) {
      return NextResponse.json({ error: 'This project does not require contributor terms' }, { status: 409 });
    }
    if (session.user.role !== 'ADMIN' && !(await isProjectMember(parsed.data.projectId, session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    key = project.contributorTermsKey ?? DEFAULT_TERMS_KEY;
  }

  const active = await getActiveTerms(key);
  if (!active) return NextResponse.json({ error: 'No contributor terms are configured' }, { status: 409 });
  if (active.version !== parsed.data.version) {
    // Not an error the user caused — tell the client to re-render the new text.
    return NextResponse.json(
      { error: 'The terms changed while you were reading them', code: 'version_changed', version: active.version },
      { status: 409 }
    );
  }

  const acceptance = await acceptTerms(session.user.id, {
    termsKey: key,
    projectId: parsed.data.projectId ?? null,
    request,
  });

  await logActivity({
    action: 'contributor_terms.accepted',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'user',
    targetId: session.user.id,
    detail: `${active.key} v${active.version}${parsed.data.projectId ? ` (project ${parsed.data.projectId})` : ''}`,
    request,
  });

  return NextResponse.json({ ok: true, acceptedAt: acceptance.acceptedAt, version: active.version });
}
