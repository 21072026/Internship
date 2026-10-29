import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { logActivity } from '@/lib/activity';
import { sendWeeklyReportReminders } from '@/services/emailService';

// POST — the coordinator's chase-up on /admin/weekly-reports (#1918): send
// this week's weekly-report reminder to the selected interns, now.
//
// It IS the Friday reminder, narrowed to a selection — same eligibility (an
// active intern still in the internship stage, who has not handed this week
// in), same channels and preferences, and the same per-week
// WeeklyReportReminder claim. So a second click, or a click after Friday's
// run, sends nothing: that idempotency is the marker's, not this route's.
//
// A nudge, never an edit: nothing here touches report content (admins are
// read-only on reports, src/app/api/weekly-reports/[id]).

const bodySchema = z.object({ relationIds: z.array(z.string().min(1).max(64)).min(1).max(200) }).strict();

export async function POST(request: Request) {
  const gate = await requirePermission('program.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const requested = [...new Set(parsed.data.relationIds)];

  return withTenantScope(session, async () => {
    // Only the caller's own tenant: an id from another org is dropped, silently
    // and indistinguishably from an ineligible one.
    const allowed = await prisma.mentorshipRelation.findMany({
      where: withinTenant({ id: { in: requested } }, await tenantWhere(session)),
      select: { id: true },
    });
    const result = await sendWeeklyReportReminders(new Date(), { relationIds: allowed.map((r) => r.id) });
    const reminded = new Set(result.remindedRelationIds);
    await logActivity({
      action: 'admin.weekly_report.chase',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'weekly_report',
      detail: JSON.stringify({ requested: requested.length, reminded: reminded.size, emailed: result.emailed, relationIds: result.remindedRelationIds }),
      request,
    });
    return NextResponse.json({
      reminded: result.remindedRelationIds,
      // Already reminded this week, handed in already, not interning any more,
      // or not ours to remind.
      skipped: requested.filter((id) => !reminded.has(id)),
      emailed: result.emailed,
    });
  });
}
