import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { notifyIfAllowed } from '@/lib/notify';
import {
  canReachGoals,
  DEFAULT_GOAL_VISIBILITY,
  GOAL_PROGRESS_MAX,
  GOAL_PROGRESS_MIN,
  GOAL_VISIBILITIES,
  visibleGoals,
} from '@/lib/goalVisibilityRule';
import type { Role } from '@prisma/client';
import { getLocale } from '@/i18n/server';
import { resolveGoalTitle, resolveTaskTitle, taskTemplateSelect, serializeTaskTemplate } from '@/lib/goalTemplates';
import { canDeleteGoal, canRewordGoal, derivedGoalProgress, subtaskPermissions } from '@/lib/goalSubtasksRule';
import { readsAsAdmin } from '@/lib/goalAccess';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';

async function relationIfAllowed(userId: string, role: string, relationId: string, callerOrgId: string | null) {
  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId } });
  // The scoped lookup above narrows nothing while MT_ENFORCE_ISOLATION is off,
  // and ADMIN is allowed below: another tenant's relation answers like a
  // missing one (#2542).
  if (!rel || !(await inCallerTenant(rel.orgId, callerOrgId))) return null;
  return canReachGoals(rel, { id: userId, role }) ? rel : null;
}

// GET ?relationId= — goals for a relation (participants/admin). A PRIVATE goal
// (#1858) is in the answer for its author only — filtered here, not in the
// panel, so no other reader of this route can show it by accident.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const relationId = new URL(request.url).searchParams.get('relationId') || '';

  const rel = await relationIfAllowed(session.user.id, session.user.role, relationId, resolveOrgId(session));
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const rows = await prisma.goal.findMany({
    where: { relationId },
    orderBy: { createdAt: 'asc' },
    include: {
      template: taskTemplateSelect,
      // The goal's steps (#1860) — to-dos with `goalId`, archived ones included
      // (put away is still done work) so the progress they derive is honest.
      subtasks: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, title: true, done: true, doneAt: true, archivedAt: true, dueDate: true,
          assigneeId: true, createdById: true, templateId: true, template: taskTemplateSelect,
          assignee: { select: { id: true, fullName: true } },
        },
      },
    },
  });
  const viewer = { id: session.user.id, role: session.user.role };
  const isAdmin = readsAsAdmin(rel, session.user.id);
  const locale = await getLocale();
  // A pooled goal or step reads in the reader's language on every view; the
  // stored `title` stays the snapshot the pool handed out.
  const goals = visibleGoals(rows, rel, viewer).map(({ template, subtasks, ...g }) => ({
    ...g,
    title: resolveGoalTitle({ title: g.title, template }, locale),
    template: serializeTaskTemplate(template),
    manualProgress: g.progress,
    progress: derivedGoalProgress(g.progress, subtasks),
    canReword: canRewordGoal(g),
    canDelete: canDeleteGoal(g, { id: session.user.id, isAdmin }),
    subtasks: subtasks.map(({ template: t, archivedAt, ...st }) => ({
      ...st,
      title: resolveTaskTitle({ title: st.title, template: t }, locale),
      archived: archivedAt !== null,
      ...subtaskPermissions(st, { id: session.user.id, isAdmin }),
    })),
  }));
  return NextResponse.json({ goals });
  });
}

const schema = z.object({
  relationId: z.string().min(1),
  // Optional only when `templateId` names the wording (#1860).
  title: z.string().min(1).max(TEXT_LIMITS.goalTitle).optional(),
  description: z.string().max(TEXT_LIMITS.goalDescription).optional(),
  dueDate: z.string().optional(),
  // #1858 — all optional: the one-line "title + due date" form still works.
  successCriteria: z.string().max(TEXT_LIMITS.goalSuccessCriteria).optional(),
  targetDate: z.string().optional(),
  progress: z.number().int().min(GOAL_PROGRESS_MIN).max(GOAL_PROGRESS_MAX).optional(),
  visibility: z.enum(GOAL_VISIBILITIES).optional(),
  // Hand out a goal from the shared pool (#1860): its wording is the template's.
  templateId: z.string().min(1).optional(),
});

// POST — create a goal (participants/admin).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const rel = await relationIfAllowed(session.user.id, session.user.role, parsed.data.relationId, resolveOrgId(session));
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // A finished mentorship takes no new ones (#1408) — the portal hides the form
  // on an archive, and this keeps a hand-rolled request from doing more.
  if (menteeWriteClosed(rel, session.user.id)) {
    return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
  }

  // A pooled goal (#1860): the active, tenant's own pool entry — the same pool
  // GET /api/todos/templates offers. The pair's mentee does not hand a goal
  // out to themselves from it; it is the giver's tool, as on /todos.
  let template: { id: string; title: string } | null = null;
  if (parsed.data.templateId) {
    if (session.user.id === rel.menteeId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    template = await prisma.projectTaskTemplate.findFirst({
      where: withinTenant({ id: parsed.data.templateId, projectId: null, archivedAt: null }, await tenantWhere(session)),
      select: { id: true, title: true },
    });
    if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 });
  }
  const title = template?.title ?? parsed.data.title?.trim();
  if (!title) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const goal = await prisma.goal.create({
    data: {
      relationId: rel.id,
      title: title.slice(0, TEXT_LIMITS.goalTitle),
      templateId: template?.id ?? null,
      description: parsed.data.description || null,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      successCriteria: parsed.data.successCriteria?.trim() || null,
      targetDate: parsed.data.targetDate ? new Date(parsed.data.targetDate) : null,
      progress: parsed.data.progress ?? null,
      visibility: parsed.data.visibility ?? DEFAULT_GOAL_VISIBILITY,
      // Record which side set the goal so it's clear who owns it — and who it
      // is, because the author is the one reader of a PRIVATE goal (#1858).
      createdByRole: session.user.role as Role,
      createdById: session.user.id,
    },
  });

  if (template) await prisma.projectTaskTemplate.update({ where: { id: template.id }, data: { useCount: { increment: 1 } } });

  // The other side of the relation learns about the new goal (#925) — no echo
  // to whoever created it. An admin is neither side, so the mentee (whose
  // development the goal tracks) is told. Link fits the recipient's role.
  // A PRIVATE goal is nobody else's business, so nobody else is told.
  const recipientId = session.user.id === rel.mentorId ? rel.menteeId : session.user.id === rel.menteeId ? rel.mentorId : rel.menteeId;
  if (recipientId !== session.user.id && goal.visibility !== 'PRIVATE') {
    const link = recipientId === rel.menteeId ? '/portal/goals' : `/mentor/mentees/${rel.id}`;
    await notifyIfAllowed(recipientId, 'goalsEvaluations', 'goal.assigned', { title: goal.title }, link);
  }
  return NextResponse.json({ goal }, { status: 201 });
  });
}
