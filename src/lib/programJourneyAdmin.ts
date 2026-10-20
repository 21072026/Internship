// The journey builder's server half (#1853): who may author a programme's
// steps, what a step input must look like, and how a step leaves the API.
// Every route under /api/admin/programs/[id]/journey goes through
// the same two halves — the route's own ADMIN check, then `journeyProgramFor()`:
// the programme's own tenant, in a vertical with mentor ↔ mentee pairs. Another tenant's programme answers 404,
// exactly like a missing one.

import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import {
  JOURNEY_ACTIONS,
  JOURNEY_ANCHORS,
  JOURNEY_AUDIENCES,
  JOURNEY_MAX_OFFSET_DAYS,
  JOURNEY_SKIP_CONDITIONS,
  isSafeContentUrl,
  readStepPayload,
  readStepTranslations,
  stepUnresolvable,
  type StepPayload,
} from '@/lib/programJourneyRule';

const title = z.string().trim().max(191).optional();

export const stepInputSchema = z.object({
  milestone: z.string().trim().max(120).nullable().optional(),
  anchor: z.enum(JOURNEY_ANCHORS),
  offsetDays: z.number().int().min(-JOURNEY_MAX_OFFSET_DAYS).max(JOURNEY_MAX_OFFSET_DAYS),
  audience: z.enum(JOURNEY_AUDIENCES),
  action: z.enum(JOURNEY_ACTIONS),
  translations: z.object({ en: title, tr: title, de: title }),
  stageKey: z.string().trim().max(64).nullable().optional(),
  url: z.string().trim().max(500).nullable().optional(),
  skipIf: z.enum(JOURNEY_SKIP_CONDITIONS).nullable().optional(),
});
export type StepInput = z.infer<typeof stepInputSchema>;

export interface JourneyProgram {
  id: string;
  orgId: string | null;
  name: string;
  term: string | null;
}

/**
 * The programme for an ADMIN session, or the response that refuses it. Each
 * route authenticates the caller itself (getServerSession + role, in the route
 * file, where check:route-auth and the OpenAPI analyser can see it) and hands
 * the session here for the capability and tenant half.
 */
export async function journeyProgramFor(session: Session, programId: string): Promise<{ program: JourneyProgram } | { refusal: NextResponse }> {
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return { refusal: capabilityRefusal };
  const program = await prisma.cohort.findFirst({
    where: withinTenant({ id: programId }, await tenantWhere(session)),
    select: { id: true, orgId: true, name: true, term: true },
  });
  if (!program) return { refusal: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  return { program };
}

/**
 * Turn a validated input into the columns of a step, or the refusal code. A
 * step the org could never schedule (a stage its pipeline lacks, a programme
 * without a start date) is refused here rather than saved to fire never.
 */
export async function stepColumns(input: StepInput, orgId: string | null): Promise<
  | { ok: true; data: { milestone: string | null; anchor: string; offsetDays: number; audience: string; action: string; title: string; translations: Prisma.InputJsonObject; payload: Prisma.InputJsonObject } }
  | { ok: false; code: string }
> {
  const translations = readStepTranslations(input.translations);
  const canonical = translations.en ?? translations.tr ?? translations.de;
  if (!canonical) return { ok: false, code: 'title_required' };
  if (input.url && !isSafeContentUrl(input.url)) return { ok: false, code: 'invalid_url' };
  const payload: StepPayload = readStepPayload({
    stageKey: input.anchor === 'STAGE_ENTRY' ? input.stageKey ?? undefined : undefined,
    url: input.action === 'PUBLISH_CONTENT' ? input.url ?? undefined : undefined,
    skipIf: input.skipIf ?? undefined,
  });
  if (input.action === 'PUBLISH_CONTENT' && !payload.url) return { ok: false, code: 'url_required' };
  const stageKeys = new Set((await resolvePipelineStages(orgId)).map((s) => s.key));
  const unresolvable = stepUnresolvable({ anchor: input.anchor, offsetDays: input.offsetDays, payload }, stageKeys);
  if (unresolvable) return { ok: false, code: unresolvable };
  return {
    ok: true,
    data: {
      milestone: input.milestone?.trim() || null,
      anchor: input.anchor,
      offsetDays: input.offsetDays,
      audience: input.audience,
      action: input.action,
      title: canonical,
      translations,
      payload: payload as Prisma.InputJsonObject,
    },
  };
}

export const STEP_SELECT = {
  id: true,
  order: true,
  milestone: true,
  anchor: true,
  offsetDays: true,
  audience: true,
  action: true,
  payload: true,
  title: true,
  translations: true,
  publishedAt: true,
  archivedAt: true,
  _count: { select: { runs: true } },
} as const;

export function serializeStep(s: {
  id: string; order: number; milestone: string | null; anchor: string; offsetDays: number; audience: string; action: string;
  payload: unknown; title: string; translations: unknown; publishedAt: Date | null; archivedAt: Date | null; _count?: { runs: number };
}) {
  return {
    id: s.id,
    order: s.order,
    milestone: s.milestone,
    anchor: s.anchor,
    offsetDays: s.offsetDays,
    audience: s.audience,
    action: s.action,
    payload: readStepPayload(s.payload),
    title: s.title,
    translations: readStepTranslations(s.translations),
    publishedAt: s.publishedAt?.toISOString() ?? null,
    archivedAt: s.archivedAt?.toISOString() ?? null,
    runs: s._count?.runs ?? 0,
  };
}
