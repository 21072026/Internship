// The two go-live week numbers for the funnel card (#2578): the median time to
// first contact and the trial-end-date coverage. The arithmetic is the pure
// src/lib/firstContactRule.ts; this is only the read.
//
// Every query takes the caller's tenant fragment by hand (`withinTenant`), like
// the rest of /api/admin/analytics/funnel, because the tenant scope is a
// passthrough with MT_ENFORCE_ISOLATION off. `scope` is the funnel route's own
// relation filter (programme + a PROGRAM_ADMIN's grants), passed in unchanged so
// these numbers describe the same records as the card around them.
//
// Nothing here returns a person or a record: counts, one median, one rate.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { TRIAL_ACTIVE_STAGE_KEY } from '@/lib/trialReminderRule';
import {
  firstContactSummary,
  trialEndCoverage,
  type FirstContactSummary,
  type TrialEndCoverage,
} from '@/lib/firstContactRule';

export interface GoLiveMetrics {
  firstContact: FirstContactSummary;
  trialEndCoverage: TrialEndCoverage;
}

export async function goLiveMetrics(input: {
  tenant: TenantWhere;
  scope: Prisma.MentorshipRelationWhereInput;
  from: Date | null;
  to: Date | null;
}): Promise<GoLiveMetrics> {
  const { tenant, scope, from, to } = input;
  const window = { from, to };

  // A record's clock starts at its request, which is never after the record
  // itself, so "started on or after `from`" is a safe superset for the window;
  // the exact cut is the rule's.
  const relations = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ ...scope, ...(from ? { startDate: { gte: from } } : {}) }, tenant),
    select: {
      startDate: true,
      companyId: true,
      interactions: { orderBy: { date: 'asc' }, take: 1, select: { date: true } },
    },
  });

  // The demo request each record came from: the enquiry converted into its
  // account. Several enquiries for one account: the earliest is when the
  // company first asked.
  const companyIds = [...new Set(relations.map((r) => r.companyId).filter((id): id is string => !!id))];
  const requestedAt = new Map<string, Date>();
  if (companyIds.length > 0) {
    const inquiries = await prisma.companyInquiry.findMany({
      where: withinTenant({ convertedCompanyId: { in: companyIds } }, tenant),
      select: { convertedCompanyId: true, createdAt: true },
    });
    for (const q of inquiries) {
      if (!q.convertedCompanyId) continue;
      const seen = requestedAt.get(q.convertedCompanyId);
      if (!seen || q.createdAt < seen) requestedAt.set(q.convertedCompanyId, q.createdAt);
    }
  }

  const firstContact = firstContactSummary(
    relations.map((r) => ({
      requestedAt: r.companyId ? requestedAt.get(r.companyId) ?? null : null,
      startDate: r.startDate,
      firstInteractionAt: r.interactions[0]?.date ?? null,
    })),
    window,
  );

  const trials = await prisma.mentorshipRelation.findMany({
    // Live trials only: a closed record left on the trial stage is not a trial
    // anybody has to give an end date any more.
    where: withinTenant({ ...scope, status: 'ACTIVE' as const, pipelineStatus: TRIAL_ACTIVE_STAGE_KEY }, tenant),
    select: { startDate: true, trialStartedAt: true, trialEndsAt: true },
  });

  return { firstContact, trialEndCoverage: trialEndCoverage(trials, window) };
}
