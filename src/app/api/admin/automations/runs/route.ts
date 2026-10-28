import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { prisma } from '@/lib/prisma';

// The run log (#1704): the org's AutomationRun rows, newest first, optionally
// for one rule — status, per-action results and the error text. Keyset paged by
// `before` (an ISO instant). docs/automation-rules.md.

const PAGE = 50;

export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const orgId = await settingsOrgOf(gate.session);
  const url = new URL(request.url);
  const ruleId = url.searchParams.get('ruleId');
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : null;
  return withTenantScope(gate.session, async () => {
    const runs = await prisma.automationRun.findMany({
      where: { orgId, ...(ruleId ? { ruleId } : {}), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: PAGE + 1,
      select: {
        id: true,
        ruleId: true,
        relationId: true,
        fromStage: true,
        toStage: true,
        status: true,
        results: true,
        error: true,
        runAt: true,
        finishedAt: true,
        createdAt: true,
        rule: { select: { name: true } },
      },
    });
    const page = runs.slice(0, PAGE);
    const relations = await prisma.mentorshipRelation.findMany({
      where: { orgId, id: { in: [...new Set(page.map((r) => r.relationId))] } },
      select: { id: true, mentee: { select: { fullName: true } } },
    });
    const names = new Map(relations.map((r) => [r.id, r.mentee?.fullName ?? '']));
    return NextResponse.json({
      runs: page.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        ruleName: r.rule.name,
        relationId: r.relationId,
        menteeName: names.get(r.relationId) ?? '',
        fromStage: r.fromStage,
        toStage: r.toStage,
        status: r.status,
        results: Array.isArray(r.results) ? r.results : [],
        error: r.error,
        runAt: r.runAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      nextBefore: runs.length > PAGE ? page[page.length - 1].createdAt.toISOString() : null,
    });
  });
}
