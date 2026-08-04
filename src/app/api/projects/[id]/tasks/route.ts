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

// A task may be created from free text (`title`) or from the template pool
// (`templateIds`) — the latter is the "send the standard goals to the person who
// just joined" path (#51). Either way `assigneeId` decides whether it lands as a
// personal goal or stays an unassigned project-wide one that a member can claim.
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

    const titles: string[] = [];
    // Titles that came from the pool: they are already templates, so the capture
    // below must not copy the resolved wording back in as a new one.
    const fromTemplate = new Set<string>();
    if (parsed.data.templateIds?.length) {
      const templates = await prisma.projectTaskTemplate.findMany({
        where: { id: { in: parsed.data.templateIds }, OR: [{ projectId: id }, { projectId: null }] },
        select: { id: true, title: true, translations: true },
      });
      // A template can be written in three languages; the goal the assignee
      // reads is a plain string, so resolve it here in *their* language.
      const assigneeLanguage = assigneeId
        ? (
            await prisma.user.findUnique({
              where: { id: assigneeId },
              select: { preferredLanguage: true },
            })
          )?.preferredLanguage
        : null;
      for (const tpl of templates) {
        const resolved = resolveTemplateTitle(tpl, assigneeLanguage);
        titles.push(resolved);
        fromTemplate.add(resolved);
      }
      if (templates.length > 0) {
        await prisma.projectTaskTemplate.updateMany({
          where: { id: { in: templates.map((t) => t.id) } },
          data: { useCount: { increment: 1 } },
        });
      }
    }
    if (parsed.data.title) titles.push(parsed.data.title);
    if (titles.length === 0) return NextResponse.json({ error: 'Nothing to create' }, { status: 400 });

    let order = await prisma.projectTask.count({ where: { projectId: id } });
    const created = [];
    for (const title of titles) {
      created.push(
        await prisma.projectTask.create({
          data: { projectId: id, title, order: order++, assigneeId: assigneeId ?? null },
        })
      );
      // Keep the pool current: a goal written by hand becomes a template too, so
      // the next member can be given it in one click. A goal that came *from*
      // the pool is skipped — capturing it would clone the shared template into
      // this project under whatever language it was resolved to.
      if (!fromTemplate.has(title)) {
        await prisma.projectTaskTemplate
          .upsert({
            where: { projectId_title: { projectId: id, title } },
            update: {},
            create: { projectId: id, title, createdById: session.user.id },
          })
          .catch(() => null);
      }
    }

    if (assigneeId && assigneeId !== session.user.id) {
      await notify(
        assigneeId,
        'project',
        created.length === 1
          ? `New goal on "${project.name}": ${created[0].title}`
          : `${created.length} new goals on "${project.name}".`,
        await goalLinkFor(assigneeId, id)
      );
    }

    return NextResponse.json({ tasks: created, task: created[0] }, { status: 201 });
  });
}
