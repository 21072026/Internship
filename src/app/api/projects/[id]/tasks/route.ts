import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canManageProject, isProjectMember } from '@/lib/projectAccess';
import { notify } from '@/lib/notify';
import { withTenantScope } from '@/lib/orgContext';
import { goalLinkFor } from '@/lib/projectGoalLink';
import { resolveTemplateTitle } from '@/lib/goalTemplates';
import { defaultLocale } from '@/i18n/config';

// A task may be created from free text (`title`) or from the template pool
// (`templateIds`) — the latter is the "send the standard goals to the person who
// just joined" path (#51). Either way `assigneeId` decides whether it lands as a
// personal goal or stays an unassigned project-wide one that a member can claim.
//
// A to-do sent from the pool keeps a reference to its template (#1113): the
// wording is then read from the template on every render, so rewording it once
// reaches everyone who has it, in their own language. Writing a to-do by hand no
// longer copies it into the pool — that auto-capture is what filled the pool with
// the very to-dos that had just been handed out, so the same wording came back
// round after round. The pool is now only what someone put there on purpose.
const schema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    templateIds: z.array(z.string().min(1)).max(50).optional(),
    assigneeId: z.string().min(1).nullable().optional(),
  })
  .refine((d) => Boolean(d.title) || (d.templateIds?.length ?? 0) > 0, {
    message: 'title or templateIds is required',
  });

// POST — add task(s) to a project (project managers and members).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;

    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Tasks are collaborative (#619): owners AND mentor members may edit.
    if (!canManageProject(session.user, project) && !(await isProjectMember(session.user, id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { assigneeId } = parsed.data;

    // Only someone already on the project can be given one of its goals.
    if (assigneeId) {
      const member = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: id, userId: assigneeId } },
        select: { id: true },
      });
      const legacy = member
        ? null
        : await prisma.mentorshipRelation.findFirst({
            where: { projectId: id, menteeId: assigneeId },
            select: { id: true },
          });
      if (!member && !legacy) {
        return NextResponse.json({ error: 'The assignee must be a project member' }, { status: 400 });
      }
    }

    // What to create: a hand-written to-do carries its own wording, a pooled one
    // carries a reference and a snapshot of the wording for the day the template
    // row is gone.
    const rows: { title: string; templateId: string | null }[] = [];
    if (parsed.data.templateIds?.length) {
      const templates = await prisma.projectTaskTemplate.findMany({
        // An archived template is no longer offered, so it cannot be handed out
        // either — the ones already assigned keep working.
        where: {
          id: { in: parsed.data.templateIds },
          archivedAt: null,
          OR: [{ projectId: id }, { projectId: null }],
        },
        select: { id: true, title: true, translations: true },
      });
      // The snapshot is the canonical wording; what the assignee *reads* is
      // resolved from the template in their own language on every render, so it
      // follows both later edits and a change of language.
      for (const tpl of templates) {
        rows.push({ title: resolveTemplateTitle(tpl, defaultLocale), templateId: tpl.id });
      }
      if (templates.length > 0) {
        await prisma.projectTaskTemplate.updateMany({
          where: { id: { in: templates.map((t) => t.id) } },
          data: { useCount: { increment: 1 } },
        });
      }
    }
    if (parsed.data.title) rows.push({ title: parsed.data.title, templateId: null });
    if (rows.length === 0) return NextResponse.json({ error: 'Nothing to create' }, { status: 400 });

    let order = await prisma.projectTask.count({ where: { projectId: id } });
    const created = [];
    for (const row of rows) {
      created.push(
        await prisma.projectTask.create({
          data: {
            projectId: id,
            title: row.title,
            templateId: row.templateId,
            order: order++,
            assigneeId: assigneeId ?? null,
            createdById: session.user.id,
          },
        })
      );
    }

    if (assigneeId && assigneeId !== session.user.id) {
      // The notification is written now, so it carries the wording the assignee
      // reads — their language, not whoever sent it.
      const assigneeLanguage = (
        await prisma.user.findUnique({ where: { id: assigneeId }, select: { preferredLanguage: true } })
      )?.preferredLanguage;
      const firstTitle = created[0].templateId
        ? resolveTemplateTitle(
            (await prisma.projectTaskTemplate.findUnique({
              where: { id: created[0].templateId },
              select: { title: true, translations: true },
            })) ?? { title: created[0].title },
            assigneeLanguage
          )
        : created[0].title;
      await notify(
        assigneeId,
        'project',
        created.length === 1
          ? `New goal on "${project.name}": ${firstTitle}`
          : `${created.length} new goals on "${project.name}".`,
        await goalLinkFor(assigneeId, id)
      );
    }

    return NextResponse.json({ tasks: created, task: created[0] }, { status: 201 });
  });
}
