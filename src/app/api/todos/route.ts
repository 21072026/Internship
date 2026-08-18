import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { notify } from '@/lib/notify';
import { resolveTemplateTitle, serializeTaskTemplate, taskTemplateSelect } from '@/lib/goalTemplates';
import { defaultLocale } from '@/i18n/config';

// One person's to-do list, whole (#1113).
//
// The same row (ProjectTask) used to reach its reader through two unrelated
// pages: a to-do a mentor handed out sat on the recipient's profile, a project's
// own goals sat on the project page, and there was nowhere to write yourself a
// line at all. This is the single read/write side of all of it:
//
//   todos — everything assigned to me: what a mentor gave me, what came from a
//           project, what I wrote for myself
//   open  — the unassigned goals on my projects, which I may take
//
// A shared to-do ships its template alongside `title`, so the client renders the
// wording in the reader's own language and picks up any later rewording. That
// reference is what makes the pool dynamic instead of a one-time copy.
//
// Reading someone else's list: an ADMIN may, and a MENTOR may for their own
// mentee — but only the to-dos that came from a project or from somebody else.
// A line you wrote for yourself on your own list stays yours.

const listSelect = {
  id: true,
  title: true,
  done: true,
  doneAt: true,
  archivedAt: true,
  createdAt: true,
  templateId: true,
  assigneeId: true,
  createdById: true,
  template: taskTemplateSelect,
  project: { select: { id: true, name: true } },
  author: { select: { id: true, fullName: true } },
} as const;

type Row = {
  id: string;
  title: string;
  done: boolean;
  doneAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  templateId: string | null;
  assigneeId: string | null;
  createdById: string | null;
  template: { id: string; title: string; translations: unknown; archivedAt: Date | null } | null;
  project: { id: string; name: string } | null;
  author: { id: string; fullName: string } | null;
};

function serialize(row: Row, viewer: { id: string; role: string }, ownerId: string) {
  const viewerId = viewer.id;
  const shared = row.templateId !== null;
  const ownList = viewerId === ownerId;
  const author = viewerId === row.createdById;
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    doneAt: row.doneAt,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt,
    project: row.project,
    // Who put it on the list — a mentor, an admin, or the person themselves.
    author: row.author && row.author.id !== ownerId ? row.author : null,
    // Present = the wording lives in the shared pool: rendered from the template
    // in the reader's language, and not this row's to reword.
    template: serializeTaskTemplate(row.template),
    shared,
    // What the *viewer* may do with it, mirroring PATCH/DELETE
    // /api/project-tasks/[taskId]. A shared to-do is checkable and archivable but
    // never editable or deletable by the person who received it — it was given to
    // them, and it is the pool's to retire (#1113).
    canCheck: ownList || author || viewer.role === 'ADMIN',
    // Rewording is for personal to-dos only; a project's wording is edited on the
    // project, and a shared one in the pool.
    canEdit: !shared && row.project === null && (author || (ownList && row.createdById === null)),
    canDelete: !shared && (author || ownList),
  };
}

/** Whether `viewer` may read/write `targetId`'s list. */
async function mayReach(
  viewer: { id: string; role: string },
  targetId: string
): Promise<boolean> {
  if (viewer.id === targetId) return true;
  if (viewer.role === 'ADMIN') return true;
  const mentorship = await prisma.mentorshipRelation.findFirst({
    where: { mentorId: viewer.id, menteeId: targetId },
    select: { id: true },
  });
  return Boolean(mentorship);
}

// GET — my to-dos, or (for an admin / their mentor) someone else's.
// ?archived=1 returns the ones that have been put away instead of the active list.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const viewerId = session.user.id;
    const url = new URL(request.url);
    const ownerId = url.searchParams.get('userId') || viewerId;
    const archived = url.searchParams.get('archived') === '1';

    if (!(await mayReach(session.user, ownerId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const ownList = ownerId === viewerId;
    const todos = await prisma.projectTask.findMany({
      where: {
        assigneeId: ownerId,
        archivedAt: archived ? { not: null } : null,
        // Somebody else's private lines are not for a visitor to read: on another
        // person's list, only what a project or another person put there shows.
        ...(ownList ? {} : { OR: [{ projectId: { not: null } }, { createdById: { not: ownerId } }] }),
      },
      orderBy: [{ done: 'asc' }, { createdAt: 'desc' }],
      select: listSelect,
    });

    // The open goals on my own projects: nobody has taken them, so they are an
    // invitation rather than an obligation — listed apart from the rest. Only on
    // my own list; on someone else's page they would be noise.
    let open: Row[] = [];
    if (ownList && !archived) {
      const memberships = await prisma.projectMember.findMany({
        where: { userId: viewerId },
        select: { projectId: true },
      });
      const projectIds = memberships.map((m) => m.projectId);
      if (projectIds.length) {
        open = (await prisma.projectTask.findMany({
          where: { projectId: { in: projectIds }, assigneeId: null, archivedAt: null, done: false },
          orderBy: [{ order: 'asc' }],
          select: listSelect,
        })) as Row[];
      }
    }

    return NextResponse.json({
      todos: (todos as Row[]).map((r) => serialize(r, session.user, ownerId)),
      open: open.map((r) => serialize(r, session.user, ownerId)),
      ownList,
      // Whoever may reach a list may also add to it.
      canAssign: true,
    });
  });
}

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    // Shared-pool templates to hand over, straight from a person's list — no
    // project needed. The to-do keeps a reference, so the wording stays live.
    templateIds: z.array(z.string().min(1)).max(50).optional(),
    // Omit for your own list.
    assigneeId: z.string().min(1).optional(),
  })
  .refine((d) => Boolean(d.title) || (d.templateIds?.length ?? 0) > 0, {
    message: 'title or templateIds is required',
  });

// POST — put a to-do on a list: mine (a line for myself) or my mentee's (what I
// want them to do, hand-written or from the shared pool).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const viewerId = session.user.id;
    const assigneeId = parsed.data.assigneeId ?? viewerId;
    if (!(await mayReach(session.user, assigneeId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const rows: { title: string; templateId: string | null }[] = [];
    if (parsed.data.templateIds?.length) {
      // Only the shared pool is reachable here — a project's own templates are
      // handed out from that project, where the assignee is a member.
      const templates = await prisma.projectTaskTemplate.findMany({
        where: { id: { in: parsed.data.templateIds }, projectId: null, archivedAt: null },
        select: { id: true, title: true, translations: true },
      });
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

    const created = [];
    for (const row of rows) {
      created.push(
        await prisma.projectTask.create({
          data: {
            title: row.title,
            templateId: row.templateId,
            assigneeId,
            createdById: viewerId,
            projectId: null,
          },
          select: listSelect,
        })
      );
    }

    if (assigneeId !== viewerId) {
      const language = (
        await prisma.user.findUnique({ where: { id: assigneeId }, select: { preferredLanguage: true } })
      )?.preferredLanguage;
      const first = created[0] as Row;
      const firstTitle = first.template ? resolveTemplateTitle(first.template, language) : first.title;
      await notify(
        assigneeId,
        created.length === 1 ? 'project.newTodo' : 'project.newTodos',
        created.length === 1 ? { title: firstTitle } : { count: created.length },
        '/todos'
      );
    }

    return NextResponse.json(
      { todos: (created as Row[]).map((r) => serialize(r, session.user, assigneeId)) },
      { status: 201 }
    );
  });
}
