import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { requirePermission } from '@/lib/authz';
import { nudgeScope } from '@/lib/nudges/adminGuard';
import { DRY_RUN_WRITER, evaluateNudgeRule, nudgeRuleSelect } from '@/lib/nudges/evaluate';

/** The sample of names the dry run returns. */
const SAMPLE = 25;

// The dry run (#1686): the SAME evaluation the live run makes, with a writer
// that does not write — so it queues no job, sends nothing and creates no
// NudgeSend row. It answers who the rule would reach right now, a sample of
// up to 25 names, and how many the protections drop and why. For an event
// rule, "right now" is "if every relation's event fired today".
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission('org.settings.write', { request });
  if ('error' in auth) return auth.error;
  const g = await nudgeScope(auth.session);
  if ('error' in g) return g.error;
  const rule = await prisma.nudgeRule.findFirst({ where: { id: (await params).id, orgId: g.orgId }, select: nudgeRuleSelect });
  if (!rule) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const result = await runWithOrg(g.orgId, () => evaluateNudgeRule(rule, { writer: DRY_RUN_WRITER }));
  return NextResponse.json({
    matched: result.matched,
    count: result.recipients.length,
    sample: result.recipients.slice(0, SAMPLE).map((r) => ({ name: r.name, role: r.role })),
    dropped: result.dropped,
    truncated: result.truncated,
  });
}
