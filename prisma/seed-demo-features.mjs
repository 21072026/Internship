// Demo coverage for the surfaces that shipped after the demo seed was last
// widened (#2061 — "no empty screens, and stay that way"): group sessions
// (#1856), stage automations (#1703/#1704), nudges (#1684), the billing usage
// tab (#1763), hiring applications (#1828) and — on the MARKETING tenant only —
// the affiliate programme (#3116).
//
// Same contract as the rest of prisma/seed-demo.mjs:
//   · synthetic only (@demo.example.com, "demo" in every free text);
//   · idempotent — stable ids or natural unique keys, empty updates, so a second
//     run creates nothing and a visitor's edits between runs survive;
//   · inert — every automation and nudge rule is seeded DISABLED (the product's
//     own default: an admin dry-runs first), so seeding a topic environment can
//     never send a mail. The run logs below are history rows, not executions.
//
// Called from seed-demo.mjs, which has already run assertSafeDemoTarget().

import { interestToApplication } from '../scripts/applications-backfill-lib.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days) => new Date(Date.now() + days * DAY_MS);

/** 'YYYY-MM' of the UTC month `back` months before the current one. */
function periodBack(back) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The internship tenant's newer surfaces. `relations` is the seeder's
 * `demoRelations` list restricted to this org (id, mentorId, menteeId,
 * pipelineStatus).
 */
export async function seedInternshipFeatures({ prisma, orgId, adminId, mentorIds, relations, cohortId }) {
  const counts = { events: 0, registrations: 0, automationRules: 0, automationRuns: 0, nudgeRules: 0, nudgeSends: 0, usageRows: 0, applications: 0 };
  const menteeIds = [...new Set(relations.map((r) => r.menteeId))];

  // ── Group sessions (#1856) ────────────────────────────────────────────────
  // One past briefing with attendance recorded, one full office hour with a
  // waitlist, one open employer session. `seatsTaken` equals the REGISTERED
  // rows exactly — it is the capacity's race guard (src/lib/groupEvents.ts).
  const eventSpecs = [
    {
      id: 'demo-event-kickoff', title: 'Programme kick-off briefing (demo)', hostId: adminId, audience: 'ALL',
      startsAt: daysFromNow(-14), durationMinutes: 60, capacity: null, location: 'Demo campus, room 1',
      description: 'Synthetic demo event: what the programme looks like, who to ask, how weekly reports work.',
      registrants: menteeIds.slice(0, 5).map((userId, i) => ({ userId, state: 'REGISTERED', attendance: i === 4 ? 'NO_SHOW' : 'ATTENDED' })),
    },
    {
      id: 'demo-event-office-hour', title: 'Mentor office hour — CV review (demo)', hostId: mentorIds[0], audience: 'MENTEES',
      startsAt: daysFromNow(3), durationMinutes: 45, capacity: 3, location: 'Online (demo)',
      description: 'Synthetic demo office hour. Bring one CV question.',
      registrants: menteeIds.slice(0, 4).map((userId, i) => ({ userId, state: i < 3 ? 'REGISTERED' : 'WAITLISTED' })),
    },
    {
      id: 'demo-event-employer', title: 'Employer info session (demo)', hostId: adminId, audience: 'MENTEES',
      startsAt: daysFromNow(10), durationMinutes: 60, capacity: 20, location: 'Demo campus, auditorium', programId: cohortId,
      description: 'Synthetic demo session: a partner company presents its internship tracks.',
      registrants: menteeIds.slice(2, 4).map((userId) => ({ userId, state: 'REGISTERED' })),
    },
  ];
  for (const spec of eventSpecs) {
    if (!spec.hostId) continue;
    const seatsTaken = spec.registrants.filter((r) => r.state === 'REGISTERED').length;
    const existing = await prisma.programEvent.findUnique({ where: { id: spec.id }, select: { id: true } });
    if (!existing) {
      await prisma.programEvent.create({
        data: {
          id: spec.id, orgId, programId: spec.programId ?? null, title: spec.title, description: spec.description,
          startsAt: spec.startsAt, timeZone: 'Europe/Berlin', durationMinutes: spec.durationMinutes,
          capacity: spec.capacity, seatsTaken, location: spec.location, hostId: spec.hostId,
          audience: spec.audience, createdById: adminId, publishedAt: new Date(spec.startsAt.getTime() - 21 * DAY_MS),
        },
      });
      counts.events++;
    }
    for (const [i, r] of spec.registrants.entries()) {
      const exists = await prisma.eventRegistration.findUnique({
        where: { eventId_userId: { eventId: spec.id, userId: r.userId } },
        select: { id: true },
      });
      if (exists) continue;
      await prisma.eventRegistration.create({
        data: {
          eventId: spec.id, userId: r.userId, state: r.state,
          // Queue order: the waitlist is promoted oldest first.
          registeredAt: new Date(spec.startsAt.getTime() - (20 - i) * DAY_MS),
          attendance: r.attendance ?? null,
          attendedAt: r.attendance === 'ATTENDED' ? spec.startsAt : null,
          attendanceRecordedById: r.attendance ? spec.hostId : null,
        },
      });
      counts.registrations++;
    }
  }

  // ── Stage automations (#1703/#1704) ───────────────────────────────────────
  // Shapes from src/lib/automation/rule.ts (ruleInputSchema). Disabled, so the
  // `automation` subscriber skips them; the runs are back-dated history for
  // the run log, ids and codes only.
  const ruleSpecs = [
    {
      id: 'demo-automation-interview', name: 'Interview pending: nudge the mentor (demo)', trigger: 'STAGE_ENTRY',
      stageKey: 'INTERVIEW_PENDING_250', conditions: [{ field: 'hasCompany', op: 'eq', value: true }],
      actions: [{ type: 'sendTemplateEmail', template: 'mentorCheckIn' }, { type: 'setStageDeadline', days: 7 }],
      delayMinutes: 0, position: 0,
    },
    {
      id: 'demo-automation-internship', name: 'Internship started: tell the mentee what comes next (demo)', trigger: 'STAGE_ENTRY',
      stageKey: 'INTERNSHIP_IN_PROGRESS_450', conditions: [],
      actions: [{ type: 'sendTemplateEmail', template: 'menteeNextStep' }, { type: 'notifyRole', role: 'admins' }],
      delayMinutes: 60, position: 1,
    },
  ];
  for (const spec of ruleSpecs) {
    const existing = await prisma.automationRule.findUnique({ where: { id: spec.id }, select: { id: true } });
    if (existing) continue;
    await prisma.automationRule.create({
      data: {
        id: spec.id, orgId, name: spec.name, trigger: spec.trigger, stageKey: spec.stageKey,
        conditions: spec.conditions, actions: spec.actions, delayMinutes: spec.delayMinutes,
        enabled: false, position: spec.position, createdById: adminId, lastSimulatedAt: daysFromNow(-2),
      },
    });
    counts.automationRules++;
  }
  const internshipRelation = relations.find((r) => r.pipelineStatus === 'INTERNSHIP_IN_PROGRESS_450') ?? relations[0];
  const otherRelation = relations.find((r) => r.id !== internshipRelation?.id);
  const runSpecs = [
    { ruleId: 'demo-automation-internship', eventId: 'demo-event-run-1', relation: internshipRelation, from: 'INTERNSHIP_STARTING_300', to: 'INTERNSHIP_IN_PROGRESS_450', status: 'SUCCESS', ago: 9,
      results: [{ index: 0, type: 'sendTemplateEmail', status: 'ok' }, { index: 1, type: 'notifyRole', status: 'ok' }] },
    { ruleId: 'demo-automation-interview', eventId: 'demo-event-run-2', relation: otherRelation, from: 'APPROVAL_PENDING_220', to: 'INTERVIEW_PENDING_250', status: 'SKIPPED', ago: 4,
      results: [], error: null },
  ];
  for (const spec of runSpecs) {
    if (!spec.relation) continue;
    const exists = await prisma.automationRun.findUnique({
      where: { ruleId_eventId: { ruleId: spec.ruleId, eventId: spec.eventId } },
      select: { id: true },
    });
    if (exists) continue;
    const at = daysFromNow(-spec.ago);
    await prisma.automationRun.create({
      data: {
        orgId, ruleId: spec.ruleId, eventId: spec.eventId, relationId: spec.relation.id,
        fromStage: spec.from, toStage: spec.to, status: spec.status, results: spec.results,
        runAt: at, finishedAt: at, createdAt: at,
      },
    });
    counts.automationRuns++;
  }

  // ── Nudges (#1684) ────────────────────────────────────────────────────────
  // Shapes from src/lib/nudges/rule.ts. Disabled; a scan rule and an event rule.
  const nudgeSpecs = [
    {
      id: 'demo-nudge-quiet-mentees', name: 'Mentees with no contact for two weeks (demo)',
      trigger: { kind: 'scan' },
      segment: { conditions: [{ field: 'role', op: 'eq', value: 'MENTEE' }, { field: 'daysSinceLastInteraction', op: 'gte', value: 14 }] },
      subjectEn: 'How is it going? (demo)', subjectTr: 'Nasıl gidiyor? (demo)', subjectDe: 'Wie läuft es? (Demo)',
      bodyEn: 'Synthetic demo nudge: it has been a while — reply to your mentor or book a slot.',
      bodyTr: 'Sentetik demo hatırlatması: bir süredir haber yok — mentoruna yaz ya da bir zaman ayır.',
      bodyDe: 'Synthetische Demo-Erinnerung: Es ist eine Weile her — schreib deinem Mentor oder buche einen Termin.',
    },
    {
      id: 'demo-nudge-first-meeting', name: 'After the first meeting: log the next step (demo)',
      trigger: { kind: 'event', event: 'meeting.completed' },
      segment: { conditions: [{ field: 'role', op: 'eq', value: 'MENTOR' }] },
      subjectEn: 'Log the next step (demo)', subjectTr: 'Sonraki adımı kaydet (demo)', subjectDe: 'Nächsten Schritt festhalten (Demo)',
      bodyEn: 'Synthetic demo nudge: note one agreed next step while it is fresh.',
      bodyTr: 'Sentetik demo hatırlatması: aklındayken kararlaştırılan bir sonraki adımı not et.',
      bodyDe: 'Synthetische Demo-Erinnerung: Halte den vereinbarten nächsten Schritt fest, solange er frisch ist.',
    },
  ];
  for (const spec of nudgeSpecs) {
    const existing = await prisma.nudgeRule.findUnique({ where: { id: spec.id }, select: { id: true } });
    if (existing) continue;
    const { id, ...rest } = spec;
    await prisma.nudgeRule.create({ data: { id, orgId, ...rest, enabled: false, createdById: adminId, lastEvaluatedAt: daysFromNow(-1) } });
    counts.nudgeRules++;
  }
  // History for the rule's send list: two past sends of the scan rule.
  for (const [i, userId] of menteeIds.slice(0, 2).entries()) {
    const exists = await prisma.nudgeSend.findUnique({
      where: { ruleId_userId_dedupeKey: { ruleId: 'demo-nudge-quiet-mentees', userId, dedupeKey: 'scan' } },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.nudgeSend.create({
      data: { orgId, ruleId: 'demo-nudge-quiet-mentees', userId, dedupeKey: 'scan', channel: 'EMAIL', status: 'SENT', sentAt: daysFromNow(-(5 + i * 3)) },
    });
    counts.nudgeSends++;
  }

  // ── Billing usage history (#1750/#1763) ───────────────────────────────────
  // The three closed months before this one, so the usage tab has a trend.
  // COMPUTED metrics are what the nightly rollup writes absolutely; the
  // current month is left to the job itself. Only CREATED, never updated, so a
  // real rollup that already wrote a period wins.
  const usageByMonth = [
    { back: 3, ACTIVE_MATCHED_PAIRS: 4, ADMIN_SEATS: 1, COMPANIES: 2, PROGRAMS: 1, VIDEO_ROOM: 6, AI_CALLS: 12 },
    { back: 2, ACTIVE_MATCHED_PAIRS: 5, ADMIN_SEATS: 1, COMPANIES: 2, PROGRAMS: 1, VIDEO_ROOM: 9, AI_CALLS: 18 },
    { back: 1, ACTIVE_MATCHED_PAIRS: 6, ADMIN_SEATS: 1, COMPANIES: 3, PROGRAMS: 1, VIDEO_ROOM: 11, AI_CALLS: 25 },
  ];
  for (const month of usageByMonth) {
    const period = periodBack(month.back);
    for (const [metric, value] of Object.entries(month)) {
      if (metric === 'back') continue;
      const exists = await prisma.usageRollup.findUnique({
        where: { orgId_metric_period: { orgId, metric, period } },
        select: { id: true },
      });
      if (exists) continue;
      await prisma.usageRollup.create({ data: { orgId, metric, period, value } });
      counts.usageRows++;
    }
  }

  // ── Hiring applications (#1828) ───────────────────────────────────────────
  // The demo shortlist goes through the ONE CompanyInterest → Application
  // bridge (the plain-ESM mirror the deploy backfill uses), exactly as a
  // deploy would; two self-applications fill the earlier funnel stages.
  const interests = await prisma.companyInterest.findMany({
    where: { requisitionId: { not: null }, requisition: { orgId } },
    select: { id: true, companyId: true, menteeId: true, requisitionId: true, status: true, note: true, createdAt: true, updatedAt: true },
  });
  const applicationSeeds = interests
    .map((interest) => {
      const seed = interestToApplication(interest);
      return seed && { ...seed, createdAt: interest.createdAt, decidedAt: seed.status === 'ACTIVE' ? null : interest.updatedAt, history: [seed.stage], note: `demo shortlist ${interest.id}` };
    })
    .filter(Boolean);
  const requisitions = await prisma.requisition.findMany({
    where: { orgId, status: 'OPEN' },
    select: { id: true, companyId: true },
    orderBy: { id: 'asc' },
  });
  const taken = new Set(applicationSeeds.map((s) => `${s.requisitionId}:${s.menteeId}`));
  const selfStages = [
    ['APPLIED'],
    ['APPLIED', 'SCREENING', 'INTERVIEW'],
  ];
  let selfIndex = 0;
  for (const requisition of requisitions) {
    for (const menteeId of menteeIds) {
      if (selfIndex >= selfStages.length) break;
      if (taken.has(`${requisition.id}:${menteeId}`)) continue;
      const history = selfStages[selfIndex++];
      taken.add(`${requisition.id}:${menteeId}`);
      applicationSeeds.push({
        requisitionId: requisition.id, menteeId, companyId: requisition.companyId, source: 'SELF',
        stage: history.at(-1), status: 'ACTIVE', dispositionCode: null, dispositionNote: null,
        coverNote: 'Synthetic demo application.', createdAt: daysFromNow(-(6 + history.length * 3)), decidedAt: null,
        history, note: 'demo self-application',
      });
      break;
    }
  }
  for (const seed of applicationSeeds) {
    const exists = await prisma.application.findUnique({
      where: { requisitionId_menteeId: { requisitionId: seed.requisitionId, menteeId: seed.menteeId } },
      select: { id: true },
    });
    if (exists) continue;
    const { history, note, ...data } = seed;
    await prisma.application.create({
      data: {
        orgId, ...data,
        // One ApplicationEvent per stage the synthetic history passed through,
        // the same trail moveApplicationStage() leaves.
        events: {
          create: history.map((toStage, i) => ({
            fromStage: i === 0 ? null : history[i - 1], toStage, actorId: i === 0 ? null : adminId, note,
            createdAt: new Date(data.createdAt.getTime() + i * 2 * DAY_MS),
          })),
        },
      },
    });
    counts.applications++;
  }

  return counts;
}

/**
 * The affiliate programme (#3116) — a MARKETING-only capability, so it lives on
 * the marketing tenant. Two partners, three referred customers, payments with
 * their commissions in every state, and one payout. Commission amounts follow
 * the seeded plan's first tier; they are history rows, not engine output.
 */
export async function seedAffiliateDemo({ prisma, orgId, domain }) {
  const counts = { partners: 0, customers: 0, payments: 0, commissions: 0, payouts: 0 };
  const plan = {
    currency: 'EUR',
    tiers: [{ upToMinor: 10_000, commissionMinor: 1_500 }, { upToMinor: 50_000, commissionMinor: 5_000 }],
    topCommissionMinor: 9_000, percentBps: 1_000, switchAtCustomer: null, boundaryCustomer: 'TIER',
    windowMonths: 24, payoutDays: 30, afterNotice: 'RUN_OUT',
  };
  const text = (en, tr, de) => ({ en, tr, de });
  await prisma.affiliateProgramSettings.upsert({
    where: { orgId },
    update: {},
    create: {
      orgId, plan, planVersion: 1, planEffectiveAt: daysFromNow(-120),
      landing: text('Recommend us and earn a commission (demo).', 'Bizi önerin, komisyon kazanın (demo).', 'Empfehlen Sie uns und verdienen Sie eine Provision (Demo).'),
      contract: text('Synthetic demo partner contract.', 'Sentetik demo partner sözleşmesi.', 'Synthetischer Demo-Partnervertrag.'),
      contractVersion: 1,
    },
  });

  const partnerSpecs = [
    { code: 'DEMO-AGENCY', displayName: 'Demo Agency Partner', status: 'ACTIVE' },
    { code: 'DEMO-CONSULT', displayName: 'Demo Consulting Partner', status: 'SUSPENDED' },
  ];
  const partners = [];
  for (const spec of partnerSpecs) {
    let partner = await prisma.affiliatePartner.findUnique({ where: { orgId_code: { orgId, code: spec.code } } });
    if (!partner) {
      partner = await prisma.affiliatePartner.create({
        data: { orgId, code: spec.code, displayName: spec.displayName, status: spec.status, contactEmail: `${spec.code.toLowerCase()}@${domain}`, createdAt: daysFromNow(-110) },
      });
      counts.partners++;
      await prisma.affiliateContractAcceptance.create({ data: { orgId, partnerId: partner.id, version: 1, acceptedAt: daysFromNow(-109) } });
    }
    partners.push(partner);
  }

  // customer → payments; each payment → one commission in the listed status.
  const customerSpecs = [
    { ref: 'demo-customer-001', partner: 0, payments: [
      { ref: 'demo-pay-001', amountMinor: 9_900, ago: 90, status: 'PAID' },
      { ref: 'demo-pay-002', amountMinor: 9_900, ago: 60, status: 'PAID' },
      { ref: 'demo-pay-003', amountMinor: 9_900, ago: 30, status: 'APPROVED' },
    ] },
    { ref: 'demo-customer-002', partner: 0, payments: [{ ref: 'demo-pay-004', amountMinor: 29_900, ago: 12, status: 'PENDING' }] },
    { ref: 'demo-customer-003', partner: 1, payments: [{ ref: 'demo-pay-005', amountMinor: 9_900, ago: 45, status: 'REJECTED' }] },
  ];
  const commissionFor = (amountMinor) => (amountMinor <= plan.tiers[0].upToMinor ? plan.tiers[0].commissionMinor : plan.tiers[1].commissionMinor);

  // The payout: the PAID commissions of the first partner, settled together.
  const paidTotal = customerSpecs.flatMap((c) => c.payments).filter((p) => p.status === 'PAID').reduce((n, p) => n + commissionFor(p.amountMinor), 0);
  let payout = await prisma.affiliatePayout.findFirst({ where: { orgId, partnerId: partners[0].id, reference: 'DEMO-PAYOUT-1' } });
  if (!payout) {
    payout = await prisma.affiliatePayout.create({
      data: { orgId, partnerId: partners[0].id, amountMinor: paidTotal, currency: 'EUR', reference: 'DEMO-PAYOUT-1', paidAt: daysFromNow(-20) },
    });
    counts.payouts++;
  }

  for (const spec of customerSpecs) {
    const partner = partners[spec.partner];
    let customer = await prisma.affiliateCustomer.findUnique({ where: { orgId_externalRef: { orgId, externalRef: spec.ref } } });
    if (!customer) {
      customer = await prisma.affiliateCustomer.create({ data: { orgId, partnerId: partner.id, externalRef: spec.ref, createdAt: daysFromNow(-100) } });
      counts.customers++;
    }
    for (const p of spec.payments) {
      const existing = await prisma.affiliatePayment.findUnique({ where: { orgId_externalPaymentRef: { orgId, externalPaymentRef: p.ref } } });
      if (existing) continue;
      const receivedAt = daysFromNow(-p.ago);
      const payment = await prisma.affiliatePayment.create({
        data: { orgId, customerId: customer.id, amountMinor: p.amountMinor, currency: 'EUR', receivedAt, source: 'MANUAL', externalPaymentRef: p.ref },
      });
      counts.payments++;
      await prisma.affiliateCommission.create({
        data: {
          orgId, partnerId: partner.id, customerId: customer.id, paymentId: payment.id, kind: 'TIER',
          amountMinor: commissionFor(p.amountMinor), currency: 'EUR', accruedAt: receivedAt,
          dueAt: new Date(receivedAt.getTime() + plan.payoutDays * DAY_MS),
          windowEndsAt: new Date(receivedAt.getTime() + 2 * 365 * DAY_MS), planVersion: 1, status: p.status,
          payoutId: p.status === 'PAID' ? payout.id : null, paidAt: p.status === 'PAID' ? payout.paidAt : null,
        },
      });
      counts.commissions++;
    }
  }
  return counts;
}
