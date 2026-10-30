import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { actorFromSession, can, requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { relationScheduleFields, scheduleCreateData } from '@/lib/relationSchedule';
import { relationScheduleDefaults } from '@/lib/relationScheduleDefaults';
import { DEFAULT_RELATION_KIND, isRelationKind } from '@/lib/placementKind';
import { checkActiveRelationLimit, planLimitError } from '@/lib/planGate';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { withTenantScope } from '@/lib/orgContext';
import { scopeForRole, logScopeDenial, andScope } from '@/lib/authzScope';
import { resolveOrgId } from '@/lib/orgScope';
import { resolveStartStage } from '@/lib/pipelineStages';
import { stageTrialWindow } from '@/lib/trialWindow';
import { daysInStage } from '@/lib/stageClock';
import {
  findActiveMentorship,
  AlreadyMentoredError,
  alreadyMentoredBody,
} from '@/lib/activeMentorship';
import { REAL_STAGE_MOVE } from '@/lib/stageChange';
import { stripNextActionFor } from '@/lib/nextActionRule';
import { refuseForeignTargets } from '@/lib/relationTargets';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { agreementStatusesFor, agreementStatusWhere, getActiveAgreement } from '@/lib/mentoringAgreement';
import { isAgreementStatus } from '@/lib/mentoringAgreementRule';
import { announceNewRelation, createGuardedRelation } from '@/lib/relationCreate';
import { MATCH_DECISION_NOTE_MAX } from '@/lib/matching/decisionRule';
import { getLocale } from '@/i18n/server';

const createRelationSchema = z.object({
  mentorId: z.string().min(1),
  menteeId: z.string().min(1),
  companyId: z.string().optional(),
  projectId: z.string().optional(),
  startDate: z.string().optional(),
  // PLACEMENT (default) | COACHING (#1503); whitelisted below, never z.enum.
  kind: z.string().max(16).optional(),
  // The audit record (#1789): the suggestion batch the admin was shown and
  // their note on why this mentor — stored on the decision row only.
  suggestionBatchId: z.string().min(1).max(64).optional(),
  decisionNote: z.string().max(MATCH_DECISION_NOTE_MAX).optional(),
  // What the pair agrees to (#1784): an end day or a duration, and a meeting
  // interval. Optional; the programme → org defaults fill what is left out.
  ...relationScheduleFields,
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (session.user.role === 'COMPANY' && !session.user.companyId) {
      return NextResponse.json({ error: 'Company assignment is required', code: 'company_not_assigned' }, { status: 403 });
    }
    const companyOrgId = session.user.role === 'COMPANY' ? resolveOrgId(session) : null;
    if (session.user.role === 'COMPANY' && !companyOrgId) {
      return NextResponse.json({ error: 'Organization is required', code: 'organization_required' }, { status: 403 });
    }
    // Does this caller read as an admin (the org-wide agreement column, the
    // re-engagement flag)? The permission rule answers, not the role string (#1571).
    const actor = await actorFromSession(session);
    const isAdmin = !!actor && (await can(actor, 'program.read', undefined, session));

    // Bind the request's tenant so every query below is auto-scoped once
    // MT_ENFORCE_ISOLATION is on (no-op while it's off). See orgContext.ts (#543).
    return await withTenantScope(session, async () => {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const search = searchParams.get('search');
    // The mentoring agreement column and filter (#1792) — ADMIN only, and only
    // in a vertical with pairs. A report, never a gate on the relation.
    const agreementParam = searchParams.get('agreement');
    const showsAgreement = isAdmin && (await shellCapabilities(session.user.orgId)).includes('mentorship');
    const activeAgreement = showsAgreement ? await getActiveAgreement(resolveOrgId(session)) : null;
    // Pagination is opt-in: only applied when `page` is explicitly passed, so
    // the many callers that expect the full list (board views, mentee/mentor
    // dashboards, meeting/email composers) keep working unchanged.
    const pageParam = searchParams.get('page');
    const page = Math.max(1, parseInt(pageParam || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10) || 20));

    // Fail-closed scoping (#848): SOURCE was missing from this chain and read
    // every relation in the tenant. Roles without a defined scope are denied.
    // COMPANY stays read-only and limited to its own company's relations.
    const scope = await scopeForRole(session.user, 'relation');
    if (!scope) {
      await logScopeDenial(session.user, 'GET /api/mentorship');
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Composed, never assigned (#2288). This used to spread `scope` into a
    // `Record<string, unknown>` and then set `where.OR = [...search...]`. The
    // MENTOR/MENTEE scopes are themselves an `OR` over both sides of the
    // relation, so `?search=` did not narrow them — it overwrote them, and any
    // signed-in mentor or mentee could read every relation (and every mentee's
    // e-mail) in the database. `andScope` puts the scope in its own `AND`
    // conjunct where no later filter can reach it, and the real Prisma type
    // replaces the `Record<string, unknown>` that let the collision compile.
    const where = andScope<Prisma.MentorshipRelationWhereInput>(
      scope,
      session.user.role === 'COMPANY'
        ? { orgId: companyOrgId, companyId: session.user.companyId }
        : undefined,
      // Unvalidated on purpose, exactly as before: an unknown value is a Prisma
      // error, not a silently wider list.
      status ? { status: status as Prisma.MentorshipRelationWhereInput['status'] } : undefined,
      search
        ? {
            OR: [
              { mentor: { fullName: { contains: search } } },
              { mentee: { fullName: { contains: search } } },
              { company: { name: { contains: search } } },
            ],
          }
        : undefined,
      activeAgreement && isAgreementStatus(agreementParam) ? agreementStatusWhere(agreementParam, activeAgreement.version, activeAgreement.key) : undefined
    );

    const include = {
      mentor: { select: { id: true, fullName: true, email: true, department: true } },
      mentee: {
        select: {
          id: true,
          fullName: true,
          email: true,
          university: true,
          graduationYear: true,
          skills: true,
          // So the screens that write TO a mentee — the bulk email composer
          // above all — can show which language they read (#1164).
          preferredLanguage: true,
          // Same idea for the clock they read (#1210): the scheduler previews
          // the picked time on every selected mentee's zone before inviting.
          timezone: true,
          // Only to derive `stageClockPaused` below — destructured out before
          // the response, so the pool date itself reaches no client (#1724).
          reEngageAt: true,
        },
      },
      company: { select: { id: true, name: true, industry: true } },
      _count: { select: { interactions: true } },
      // The stage clock (#1724). Only the newest move is needed — the shared
      // helper takes the latest `createdAt` and falls back to `startDate` —
      // so this stays one extra row per relation, not the whole audit trail.
      // Only real moves (#2264): a no-op row would be the newest one here and
      // would restart the stage clock at zero. See REAL_STAGE_MOVE.
      statusChanges: { where: REAL_STAGE_MOVE, orderBy: { createdAt: 'desc' as const }, take: 1, select: { createdAt: true } },
    };

    // `stageDeadline` already rides along on every row (the query uses
    // `include`, so all scalars are selected); `daysInStage` is derived here so
    // the board, the mentee list and the aging report cannot drift apart. The
    // audit row itself is dropped again — the clients only need the number, and
    // the caller's own scope is not widened by either field.
    //
    // `stageClockPaused` is the re-engagement pool (#834) reaching the chip: a
    // mentee with an agreed "we'll write in September" date is not a queue
    // anybody is late on, which is why the admin aging report already drops
    // them from its breach list. The pool date is read here and thrown away —
    // only the boolean ships, and only to the two roles that can already list
    // the pool through GET /api/re-engagement, so COMPANY and SOURCE callers
    // see exactly the payload they saw before.
    const seesPool = isAdmin || session.user.role === 'MENTOR';
    const withStageClock = <
      T extends { mentorId: string; startDate: Date; statusChanges: { createdAt: Date }[]; mentee: { reEngageAt: Date | null } },
    >(
      rows: T[]
    ) =>
      rows.map(({ statusChanges, mentee, ...rest }) => {
        const { reEngageAt, ...menteeRest } = mentee;
        return {
          // The owner's next action (#2563) rides along for the owner and ADMIN
          // only — the board card shows it; a MENTEE/COMPANY/SOURCE reader of
          // the same list does not get the owner's note about them.
          ...stripNextActionFor(session.user, rest),
          mentee: menteeRest,
          daysInStage: daysInStage({ startDate: rest.startDate, statusChanges }),
          ...(seesPool ? { stageClockPaused: reEngageAt != null } : {}),
        };
      });

    const withAgreement = async <T extends { id: string; orgId: string | null }>(rows: T[]) => {
      if (!showsAgreement) return rows;
      const statuses = await agreementStatusesFor(rows);
      return rows.map((r) => ({ ...r, agreementStatus: statuses.get(r.id) ?? null }));
    };

    if (!pageParam) {
      const relations = await prisma.mentorshipRelation.findMany({ where, include, orderBy: { startDate: 'desc' } });
      return NextResponse.json({ relations: await withAgreement(withStageClock(relations)) });
    }

    const [total, relations] = await Promise.all([
      prisma.mentorshipRelation.count({ where }),
      prisma.mentorshipRelation.findMany({
        where,
        include,
        orderBy: { startDate: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return NextResponse.json({ relations: await withAgreement(withStageClock(relations)), total, page, pageSize });
    });
  } catch (error) {
    console.error('Get mentorships error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const gate = await requirePermission('relation.write', { request });
    if ('error' in gate) return gate.error;
    const { session } = gate;

    return await withTenantScope(session, async () => {
    const body = await request.json();
    const parsed = createRelationSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { mentorId, menteeId, companyId, projectId, startDate, kind: rawKind, suggestionBatchId, decisionNote, expectedEndDate, durationMonths, expectedMeetingIntervalWeeks } = parsed.data;
    if (rawKind !== undefined && !isRelationKind(rawKind)) {
      return NextResponse.json({ error: 'Unknown kind', code: 'invalid_kind' }, { status: 400 });
    }
    const kind = rawKind ?? DEFAULT_RELATION_KIND;
    const start = startDate ? new Date(startDate) : new Date();

    // The company and project must be the admin's own tenant's (#2613, #2618):
    // unchecked, another tenant's id was attached and its name came back in
    // the response, and an unknown one was a foreign-key 500. Both now answer
    // the same 404.
    const foreignTarget = await refuseForeignTargets(session, { companyId, projectId });
    if (foreignTarget) return foreignTarget;

    const [mentor, mentee] = await Promise.all([
      prisma.user.findUnique({ where: { id: mentorId } }),
      prisma.user.findUnique({ where: { id: menteeId } }),
    ]);

    // Either side may be an admin, a mentor or a mentee (#1141): admins mentor,
    // and someone who mentors can still need mentoring themselves. What stays
    // barred is the COMPANY/SOURCE observer roles — they have no personal
    // mentorship — and pairing someone with themselves.
    const PARTICIPANT_ROLES = ['ADMIN', 'MENTOR', 'MENTEE'];

    if (!mentor || !PARTICIPANT_ROLES.includes(mentor.role)) {
      return NextResponse.json({ error: 'Invalid mentor' }, { status: 400 });
    }

    if (!mentee || !PARTICIPANT_ROLES.includes(mentee.role)) {
      return NextResponse.json({ error: 'Invalid mentee' }, { status: 400 });
    }

    if (mentorId === menteeId) {
      return NextResponse.json({ error: 'A user cannot mentor themselves' }, { status: 400 });
    }

    // Cheap pre-flight for the common case; the real guard is re-run inside the
    // transaction below (#419) — everything between here and the create is an
    // await another request can win. The refusal names the mentor in the way
    // and carries their relation id, so the admin dialog can offer the transfer
    // (#2289) instead of only reporting the block — this route is ADMIN-only,
    // which is what makes returning the name here acceptable.
    const preflightActive = await findActiveMentorship(prisma, menteeId);
    if (preflightActive) {
      return NextResponse.json(await alreadyMentoredBody(prisma, preflightActive.id), { status: 409 });
    }

    // Plan gate (#547): block a new active relation once the tenant is at its
    // plan limit. No-op for the unlimited default org; existing mentees are
    // never affected.
    const gate = await checkActiveRelationLimit(mentee.orgId);
    if (!gate.allowed) {
      return NextResponse.json(planLimitError(gate), { status: 403 });
    }

    // Capacity/availability warning (#942): advisory only, never blocking — the
    // plan gate above is the only thing that can refuse the assignment. Counted
    // *before* this new relation is created, so it reflects the mentor's load
    // going into the assignment, not after it. Single source of truth for the
    // derivation: getMentorAvailability() (#941).
    const activeMenteeCount = await prisma.mentorshipRelation.count({
      where: { mentorId, status: 'ACTIVE' },
    });
    const availability = getMentorAvailability({
      mentorCapacity: mentor.mentorCapacity,
      activeMenteeCount,
      acceptingMentees: mentor.acceptingMentees,
    });
    const warnings: string[] =
      availability.status === 'at_capacity'
        ? ['mentor_at_capacity']
        : availability.status === 'not_accepting'
          ? ['mentor_not_accepting']
          : [];

    // Start on the tenant's own first on-path stage, not the schema default
    // (#1634) — an org with custom stages has no `APPLICATION_100` column to
    // show the new relation in. Falls back to the canonical first stage for an
    // org that never touched the stage editor.
    const pipelineStatus = await resolveStartStage(mentee.orgId);
    // A tenant whose first stage is TRIAL_ACTIVE gets the trial window with
    // the create (#2551); for every other start stage this is `{}`, no query.
    const trialWindow = await stageTrialWindow({ orgId: mentee.orgId, toStage: pipelineStatus, enteredAt: new Date() });
    // The agreed duration and rhythm (#1784): what the admin chose, else the
    // org's defaults. A direct assignment carries no programme yet.
    const schedule = scheduleCreateData(
      { expectedEndDate, durationMonths, expectedMeetingIntervalWeeks },
      start,
      await relationScheduleDefaults(mentee.orgId),
    );

    // The guard and the write, adjacent and atomic (#419). The pre-flight above
    // ran before the plan gate, the availability count and resolveStartStage —
    // three awaits during which another admin could have assigned this mentee.
    // A throw here rolls the create back instead of leaving it committed behind
    // a 409. Everything after this (webhook, notifications, e-mail) stays
    // OUTSIDE: it must not run if the transaction rolls back, and must not hold
    // a transaction open across two SMTP sends.
    let relation;
    try {
      relation = await prisma.$transaction((tx) =>
        createGuardedRelation(tx, {
          mentorId,
          menteeId,
          orgId: mentee.orgId,
          pipelineStatus,
          ...trialWindow,
          companyId: companyId || null,
          projectId: projectId || null,
          startDate: start,
          ...schedule,
          kind,
          // A placement enters the funnel when it starts; coaching never does (#1503).
          funnelEnteredAt: kind === 'PLACEMENT' ? start : null,
        }),
      );
    } catch (e) {
      if (e instanceof AlreadyMentoredError) {
        return NextResponse.json(await alreadyMentoredBody(prisma, e.existingRelationId), { status: 409 });
      }
      throw e;
    }

    // Webhook, decision record, both sides' notices and mails — the shared
    // post-commit half (#1796), the same one a published round runs.
    await announceNewRelation({
      relation,
      mentor,
      mentee,
      companyId: companyId || null,
      actor: { id: session.user.id, orgId: session.user.orgId ?? null },
      decision: {
        source: 'ADMIN_DIRECT',
        suggestionBatchId: suggestionBatchId ?? null,
        note: decisionNote ?? null,
        locale: await getLocale(),
      },
    });

    return NextResponse.json({ relation, warnings }, { status: 201 });
    });
  } catch (error) {
    console.error('Create mentorship error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
