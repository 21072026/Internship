import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { logActivity } from '@/lib/activity';
import { resolveOrgId } from '@/lib/orgScope';
import { EVALUATION_SCOPES, defaultCriteria, isEvaluationScope } from '@/lib/evaluation';
import { locales } from '@/i18n/config';

// Admin management of the org's competency framework (#822).
//
// One active template per scope. A save replaces the criteria *set* of that
// template, but a criterion that disappears from the payload is DEACTIVATED,
// never deleted: evaluations scored against it still have to render its label.
// Keys are equally permanent — renaming a criterion changes its labels, since
// the key is what lives inside Evaluation.scores.
//
// Saving an EMPTY list is how an org goes back to the built-in rubric: every
// criterion is retired, the template resolves to nothing active, and the
// fallback in evaluationTemplates.ts takes over.

const labelsSchema = z.record(z.enum(locales as unknown as [string, ...string[]]), z.string().max(80));

const criterionSchema = z.object({
  // Stored inside Evaluation.scores, so it stays machine-shaped and stable.
  key: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Use letters, digits and underscores'),
  labels: labelsSchema,
  order: z.number().int().min(0).max(999).optional(),
});

const bodySchema = z.object({
  scope: z.string().refine(isEvaluationScope, 'Unknown scope'),
  name: z.string().min(1).max(120).optional(),
  criteria: z.array(criterionSchema).max(30),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = resolveOrgId(session);
  const templates = orgId
    ? await prisma.evaluationTemplate.findMany({
        where: { orgId, active: true },
        orderBy: { createdAt: 'desc' },
        include: { criteria: { orderBy: { order: 'asc' } } },
      })
    : [];

  // Always answer with both scopes, filled from the org's template when it has
  // one and from the built-ins when it does not — so the editor opens on what
  // is actually in force rather than on an empty form.
  const byScope = Object.fromEntries(
    EVALUATION_SCOPES.map((scope) => {
      const tpl = templates.find((t) => t.scope === scope);
      const criteria = tpl?.criteria.filter((c) => c.active) ?? [];
      return [
        scope,
        {
          templateId: tpl?.id ?? null,
          name: tpl?.name ?? null,
          isCustom: criteria.length > 0,
          criteria:
            criteria.length > 0
              ? criteria.map((c) => ({ key: c.key, labels: c.labels, order: c.order }))
              : defaultCriteria(scope).map((c) => ({ key: c.key, labels: null, order: c.order })),
        },
      ];
    })
  );

  return NextResponse.json({ scopes: byScope });
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { scope, criteria } = parsed.data;

  const duplicates = criteria.map((c) => c.key).filter((k, i, all) => all.indexOf(k) !== i);
  if (duplicates.length > 0) {
    return NextResponse.json(
      { error: 'Validation failed', details: { formErrors: [`Duplicate keys: ${[...new Set(duplicates)].join(', ')}`] } },
      { status: 400 }
    );
  }
  // Every criterion needs at least one language, or it would render as its key.
  const unlabelled = criteria.filter((c) => !Object.values(c.labels).some((v) => v.trim()));
  if (unlabelled.length > 0) {
    return NextResponse.json(
      { error: 'Validation failed', details: { formErrors: [`Missing label: ${unlabelled.map((c) => c.key).join(', ')}`] } },
      { status: 400 }
    );
  }

  const template =
    (await prisma.evaluationTemplate.findFirst({ where: { orgId, scope, active: true }, orderBy: { createdAt: 'desc' } })) ??
    (await prisma.evaluationTemplate.create({
      data: { orgId, scope, name: parsed.data.name || `${scope} rubric` },
    }));

  const keep = new Set(criteria.map((c) => c.key));
  await prisma.$transaction([
    // Gone from the payload → retired, not removed.
    prisma.evaluationCriterion.updateMany({
      where: { templateId: template.id, key: { notIn: [...keep] } },
      data: { active: false },
    }),
    ...criteria.map((c, i) =>
      prisma.evaluationCriterion.upsert({
        where: { templateId_key: { templateId: template.id, key: c.key } },
        update: { labels: c.labels, order: c.order ?? i, active: true },
        create: { templateId: template.id, key: c.key, labels: c.labels, order: c.order ?? i, active: true },
      })
    ),
  ]);

  await logActivity({
    action: 'evaluation_template.updated',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'evaluationTemplate',
    targetId: template.id,
    detail: `${scope} · ${criteria.length} criteria`,
    request,
  });

  return NextResponse.json({ ok: true, templateId: template.id });
}
