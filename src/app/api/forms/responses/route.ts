import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { FORM_SURFACES, type FormSurface } from '@/lib/forms/definitionRule';
import { FormWriteError, saveFormResponses } from '@/lib/forms/definitions';
import { activeForms, ownAnswers } from '@/lib/forms/active';

// The caller's OWN answers to the admin-defined questions (#1803). The person
// is always the session's user: the body is .strict(), so a request that
// names a `userId` is refused outright rather than silently ignored — there
// is no parameter through which one person writes another's answers.

const surfaceOf = (request: Request): FormSurface | null => {
  const s = new URL(request.url).searchParams.get('surface');
  return s && (FORM_SURFACES as readonly string[]).includes(s) ? (s as FormSurface) : null;
};

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const surface = surfaceOf(request);
  if (!surface) return NextResponse.json({ error: 'Invalid surface', code: 'invalid_surface' }, { status: 400 });
  return withTenantScope(session, async () => {
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    const forms = await activeForms(orgId, surface, session.user.role);
    return NextResponse.json({ answers: await ownAnswers(session.user.id, forms) });
  });
}

const putSchema = z
  .object({
    definitionId: z.string().min(1).max(40),
    answers: z.record(z.string().max(80), z.unknown()),
  })
  .strict();

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid input', code: 'invalid', issues: parsed.error.issues }, { status: 400 });
  return withTenantScope(session, async () => {
    const orgId = resolveOrgId(session) ?? (await defaultOrgId());
    // Only a form the caller is actually asked: live, in their org, for their
    // role. Anything else — another org's, a draft, a retired one — is 404.
    const def = await prisma.formDefinition.findUnique({ where: { id: parsed.data.definitionId }, select: { surface: true } });
    const target = def && (FORM_SURFACES as readonly string[]).includes(def.surface)
      ? (await activeForms(orgId, def.surface as FormSurface, session.user.role)).find((f) => f.id === parsed.data.definitionId)
      : undefined;
    if (!target) return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
    try {
      await saveFormResponses(session.user.id, target, parsed.data.answers);
    } catch (error) {
      if (error instanceof FormWriteError) return NextResponse.json({ error: error.code, code: error.code, ...error.detail }, { status: error.status });
      throw error;
    }
    return NextResponse.json({ ok: true });
  });
}
