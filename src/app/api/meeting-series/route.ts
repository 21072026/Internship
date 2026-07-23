import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canManageProject, isProjectMember } from '@/lib/projectAccess';
import { sendMeetingInviteEmail } from '@/services/emailService';
import { dispatchWebhook } from '@/lib/webhooks';
import { withTenantScope } from '@/lib/orgContext';

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const recurrenceSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  timeOfDay: z.string().regex(timePattern),
  meetLink: z.string().url().optional().or(z.literal('')),
  weeksAhead: z.number().int().min(1).max(26).default(7),
  active: z.boolean().optional(),
});

const updateSchema = recurrenceSchema.partial().extend({
  id: z.string().min(1),
  weeksAhead: z.number().int().min(1).max(26).default(7),
});

const deleteSchema = z.object({ id: z.string().min(1) });

function nextJitsiLink() {
  return `https://meet.jit.si/InternshipCRM-${randomBytes(8).toString('hex')}`;
}

function buildScheduledAt(date: Date, timeOfDay: string) {
  const [hour, minute] = timeOfDay.split(':').map((v) => Number(v));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0, 0));
}

function targetsFromRule(daysOfWeek: number[], timeOfDay: string, weeksAhead: number, from: Date) {
  const allowed = new Set(daysOfWeek);
  const out: Date[] = [];
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + weeksAhead * 7);

  for (let cursor = new Date(start); cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (!allowed.has(cursor.getUTCDay())) continue;
    const scheduledAt = buildScheduledAt(cursor, timeOfDay);
    if (scheduledAt >= from) out.push(scheduledAt);
  }
  return out;
}

async function ensureProjectAccess(
  user: { id: string; role: string; companyId?: string | null },
  projectId: string
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerType: true, ownerUserId: true, ownerCompanyId: true },
  });
  if (!project) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) as NextResponse };
  if (user.role !== 'ADMIN') {
    const member = await isProjectMember(user, projectId);
    if (!canManageProject(user, project) && !member) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) as NextResponse };
    }
  }
  return { project };
}

async function generateForSeries(series: {
  id: string;
  projectId: string | null;
  title: string;
  daysOfWeek: unknown;
  timeOfDay: string;
  fixedLink: string | null;
  active: boolean;
}, sessionUserId: string, weeksAhead: number, role: string) {
  if (!series.active || !series.projectId) return { created: 0, fixedLink: series.fixedLink };

  const memberMentees = await prisma.projectMember.findMany({
    where: { projectId: series.projectId, role: 'MENTEE' },
    select: { userId: true },
  });
  const menteeIds = [...new Set(memberMentees.map((m) => m.userId))];

  const relations = await prisma.mentorshipRelation.findMany({
    where: {
      projectId: series.projectId,
      status: 'ACTIVE',
      ...(role === 'MENTOR' ? { mentorId: sessionUserId } : {}),
      ...(menteeIds.length > 0 ? { menteeId: { in: menteeIds } } : {}),
    },
    include: { mentee: { select: { email: true, fullName: true } } },
  });
  if (relations.length === 0) return { created: 0, fixedLink: series.fixedLink };

  const days = z.array(z.number().int().min(0).max(6)).min(1).parse(series.daysOfWeek);
  const now = new Date();
  const targets = targetsFromRule(days, series.timeOfDay, weeksAhead, now);
  if (targets.length === 0) return { created: 0, fixedLink: series.fixedLink };

  const start = targets[0];
  const end = targets[targets.length - 1];
  const existing = await prisma.meeting.findMany({
    where: { seriesId: series.id, scheduledAt: { gte: start, lte: end } },
    select: { relationId: true, scheduledAt: true },
  });
  const dedupe = new Set(existing.map((m) => `${m.relationId}|${m.scheduledAt?.toISOString()}`));

  let fixedLink = series.fixedLink;
  if (!fixedLink) {
    fixedLink = nextJitsiLink();
    await prisma.meetingSeries.update({ where: { id: series.id }, data: { fixedLink } });
  }

  let created = 0;
  for (const when of targets) {
    const whenIso = when.toISOString();
    for (const rel of relations) {
      const key = `${rel.id}|${whenIso}`;
      if (dedupe.has(key)) continue;
      const rsvpToken = randomBytes(24).toString('hex');
      await prisma.meeting.create({
        data: {
          relationId: rel.id,
          title: series.title,
          scheduledAt: when,
          meetLink: fixedLink,
          rsvpToken,
          createdById: sessionUserId,
          seriesId: series.id,
        },
      });
      try {
        await sendMeetingInviteEmail({
          to: rel.mentee.email,
          fullName: rel.mentee.fullName,
          title: series.title,
          scheduledAt: when,
          meetLink: fixedLink,
          rsvpToken,
        });
      } catch (e) {
        console.error('Meeting series invite email failed:', e);
      }
      dedupe.add(key);
      created++;
    }
  }

  if (created > 0) {
    await dispatchWebhook('meeting.scheduled', {
      title: series.title,
      scheduledAt: null,
      count: created,
      seriesId: series.id,
    });
  }

  return { created, fixedLink };
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = recurrenceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { projectId, title, daysOfWeek, timeOfDay, meetLink, weeksAhead, active } = parsed.data;
    const access = await ensureProjectAccess(session.user, projectId);
    if (access.error) return access.error;

    const fixedLink = meetLink || nextJitsiLink();
    const series = await prisma.meetingSeries.create({
      data: {
        projectId,
        title,
        daysOfWeek,
        timeOfDay,
        fixedLink,
        active: active ?? true,
        createdById: session.user.id,
      },
    });

    const generation = await generateForSeries(series, session.user.id, weeksAhead, session.user.role);
    return NextResponse.json(
      { series: { ...series, fixedLink: generation.fixedLink }, createdMeetings: generation.created },
      { status: 201 }
    );
  });
}

export async function PUT(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { id, weeksAhead, ...incoming } = parsed.data;

    const current = await prisma.meetingSeries.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const targetProjectId = incoming.projectId ?? current.projectId;
    if (!targetProjectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    const access = await ensureProjectAccess(session.user, targetProjectId);
    if (access.error) return access.error;

    const data: {
      projectId?: string;
      title?: string;
      daysOfWeek?: number[];
      timeOfDay?: string;
      fixedLink?: string | null;
      active?: boolean;
    } = {};
    if (incoming.projectId !== undefined) data.projectId = incoming.projectId;
    if (incoming.title !== undefined) data.title = incoming.title;
    if (incoming.daysOfWeek !== undefined) data.daysOfWeek = incoming.daysOfWeek;
    if (incoming.timeOfDay !== undefined) data.timeOfDay = incoming.timeOfDay;
    if (incoming.meetLink !== undefined) data.fixedLink = incoming.meetLink || null;
    if (incoming.active !== undefined) data.active = incoming.active;

    const updated = await prisma.meetingSeries.update({ where: { id }, data });
    const generation = await generateForSeries(updated, session.user.id, weeksAhead, session.user.role);
    return NextResponse.json({ series: { ...updated, fixedLink: generation.fixedLink }, createdMeetings: generation.created });
  });
}

export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const current = await prisma.meetingSeries.findUnique({ where: { id: parsed.data.id } });
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (current.projectId) {
      const access = await ensureProjectAccess(session.user, current.projectId);
      if (access.error) return access.error;
    }

    const series = await prisma.meetingSeries.update({
      where: { id: parsed.data.id },
      data: { active: false },
    });
    return NextResponse.json({ ok: true, series });
  });
}
