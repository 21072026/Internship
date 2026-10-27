import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { setSetting } from '@/lib/settings';
import { logActivity } from '@/lib/activity';
import { prisma } from '@/lib/prisma';
import { TERM_DEFAULTS, TERM_TOKENS, parseTerminology, serializeTerminology } from '@/lib/terminology';
import { resolveTerminology } from '@/lib/terminology.server';
import { requireCapability } from '@/lib/capabilityGate';

// The org's (or one programme's) nouns (#1629): GET reads the stored document
// for a scope, PUT replaces it. One `terminology` setting row per layer, written
// through setSetting() — no second settings mechanism — to the CALLER's org
// (never the global row, #2628) or one of its programmes. What is stored is the
// parsed document: an unknown locale or token, or a token missing a form, is
// dropped before the write (src/lib/terminology.ts). An empty document clears
// the layer back to inheriting.

async function scopeOf(orgId: string, programId: string | null): Promise<{ programId: string | null } | null> {
  if (!programId) return { programId: null };
  const program = await prisma.cohort.findFirst({ where: { id: programId, orgId }, select: { id: true } });
  // Another tenant's programme reads as missing, never as forbidden.
  return program ? { programId: program.id } : null;
}

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  const programId = new URL(request.url).searchParams.get('programId');
  return withTenantScope(gate.session, async () => {
    const scope = await scopeOf(orgId, programId);
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({
      tokens: TERM_TOKENS,
      defaults: TERM_DEFAULTS,
      terminology: await resolveTerminology({ orgId, programId: scope.programId }),
    });
  });
}

const schema = z.object({
  // Parsed (and pruned) by parseTerminology, not here: an unknown key is
  // dropped, not refused, so the shape is only "an object".
  terminology: z.record(z.string(), z.unknown()),
  programId: z.string().min(1).max(64).optional(),
});

export async function PUT(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const orgId = await settingsOrgOf(session);
  // The nouns are the internship product's; a MARKETING tenant's come from its
  // vertical overlay and a stored value would never be read (terminologyFor).
  const refused = await requireCapability(orgId, 'mentorship');
  if (refused) return refused;

  return withTenantScope(session, async () => {
    const scope = await scopeOf(orgId, parsed.data.programId ?? null);
    if (!scope) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const value = serializeTerminology(parseTerminology(parsed.data.terminology));
    await setSetting('terminology', value, orgId, scope.programId ? { programId: scope.programId } : {});
    await logActivity({
      action: 'settings.terminology',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      detail: scope.programId ? `program=${scope.programId}` : 'org',
      request,
      orgId,
    });
    return NextResponse.json({ terminology: parseTerminology(value) });
  });
}
