// Who actually turned up to a pair's meeting (#2014).
//
// RULES THIS FILE IS BUILT AROUND (docs/meeting-attendance.md):
//   • TWO SHAPES. A Meeting row, or a recurring occurrence that has no row
//     (`<seriesId>:<ISO instant>`, the id /api/meetings/upcoming hands out) —
//     the same two the end route handles. Each has its own unique key, so a
//     double record is impossible.
//   • A PAIR'S MEETING. Attendance is recorded for meetings that belong to a
//     mentorship (a relation meeting, or a standing 1:1 series) and for its two
//     people only — it is what the cadence figure counts.
//   • THE MENTOR'S RECORD WINS. Either participant (or an admin) may record; a
//     mentee's record never overwrites one the mentor or an admin made. The
//     actor is always stored.
//   • LATE_CANCEL IS DERIVED, never typed: cancelling inside the window writes
//     it for whoever cancelled (recordLateCancel).
//   • A NUDGE, NOT A PUNISHMENT. A no-show gets exactly one neutral in-app
//     note with a way to reschedule — no score, no badge, no leaderboard.

import type { AttendanceState } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { notifyIfAllowed } from '@/lib/notify';
import { notificationLink } from '@/lib/notificationLink';
import { loadAccessibleMeeting, meetingInCallerTenant, type MeetingUser } from '@/lib/meetingAccess';
import { ruleOccurrences, SERIES_RULE_SELECT } from '@/lib/meetingSeriesOccurrences';

/** What a person may record by hand. LATE_CANCEL is only ever derived. */
export const RECORDABLE_ATTENDANCE = ['ATTENDED', 'NO_SHOW', 'EXCUSED'] as const;
export type RecordableAttendance = (typeof RECORDABLE_ATTENDANCE)[number];

/** How far back an occurrence may still be recorded — a record, not an archaeology tool. */
const RECORD_WINDOW_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export interface AttendanceTarget {
  meetingId: string | null;
  seriesId: string | null;
  occurrenceAt: Date | null;
  meetingAt: Date;
  relationId: string;
  orgId: string | null;
  mentorId: string;
  menteeId: string;
}

export type TargetResult = { target: AttendanceTarget } | { error: 'not_found' | 'not_a_pair' | 'not_started' | 'cancelled' };

/** Resolve either id shape to a pair meeting the caller takes part in. */
export async function resolveAttendanceTarget(user: MeetingUser, id: string, now = new Date()): Promise<TargetResult> {
  const colon = id.indexOf(':');
  if (colon > 0) return resolveOccurrence(user, id.slice(0, colon), id.slice(colon + 1), now);

  // Same participation rule as notes, call tokens and the end route; missing
  // and not-yours answer alike.
  if (!(await loadAccessibleMeeting(user, id))) return { error: 'not_found' };
  const row = await prisma.meeting.findUnique({
    where: { id },
    select: { scheduledAt: true, status: true, relation: { select: { id: true, orgId: true, mentorId: true, menteeId: true } } },
  });
  if (!row) return { error: 'not_found' };
  if (!row.relation) return { error: 'not_a_pair' };
  if (row.status === 'CANCELLED') return { error: 'cancelled' };
  if (!row.scheduledAt || row.scheduledAt > now) return { error: 'not_started' };
  return {
    target: {
      meetingId: id,
      seriesId: null,
      occurrenceAt: null,
      meetingAt: row.scheduledAt,
      relationId: row.relation.id,
      orgId: row.relation.orgId,
      mentorId: row.relation.mentorId,
      menteeId: row.relation.menteeId,
    },
  };
}

async function resolveOccurrence(user: MeetingUser, seriesId: string, iso: string, now: Date): Promise<TargetResult> {
  const occurrenceAt = new Date(iso);
  if (Number.isNaN(occurrenceAt.getTime())) return { error: 'not_found' };
  const series = await prisma.meetingSeries.findUnique({
    where: { id: seriesId },
    select: {
      id: true,
      projectId: true,
      relationId: true,
      project: { select: { orgId: true } },
      createdById: true,
      relation: { select: { id: true, orgId: true, mentorId: true, menteeId: true } },
      ...SERIES_RULE_SELECT,
    },
  });
  if (!series) return { error: 'not_found' };
  if (!(await meetingInCallerTenant(series, series.createdById, user.orgId))) return { error: 'not_found' };
  if (!series.relation) return { error: 'not_a_pair' };
  const rel = series.relation;
  if (user.role !== 'ADMIN' && user.id !== rel.mentorId && user.id !== rel.menteeId) return { error: 'not_found' };
  if (occurrenceAt > now) return { error: 'not_started' };
  if (now.getTime() - occurrenceAt.getTime() > RECORD_WINDOW_DAYS * DAY) return { error: 'not_found' };
  // A real occurrence of the rule, not an arbitrary instant typed into the URL.
  const real = ruleOccurrences(series, new Date(occurrenceAt.getTime() - 60_000), new Date(occurrenceAt.getTime() + 60_000)).some(
    (d) => d.getTime() === occurrenceAt.getTime(),
  );
  if (!real) return { error: 'not_found' };
  return {
    target: { meetingId: null, seriesId, occurrenceAt, meetingAt: occurrenceAt, relationId: rel.id, orgId: rel.orgId, mentorId: rel.mentorId, menteeId: rel.menteeId },
  };
}

export interface AttendanceEntry {
  userId: string;
  state: AttendanceState;
  note?: string | null;
}

export interface RecordResult {
  saved: number;
  /** Left as they were: a mentee may not overwrite the mentor's (or an admin's) record. */
  kept: number;
  /** Not one of the meeting's two people. */
  rejected: number;
}

/**
 * Record (or correct) attendance for the pair's two people. `recorder` is the
 * caller; whoever it is, the actor is stored.
 */
export async function recordAttendance(target: AttendanceTarget, recorder: MeetingUser, entries: AttendanceEntry[], now = new Date()): Promise<RecordResult> {
  const result: RecordResult = { saved: 0, kept: 0, rejected: 0 };
  const senior = (id: string, role?: string) => role === 'ADMIN' || id === target.mentorId;
  const recorderIsSenior = senior(recorder.id, recorder.role);
  for (const entry of entries) {
    if (entry.userId !== target.mentorId && entry.userId !== target.menteeId) {
      result.rejected++;
      continue;
    }
    const where = target.meetingId
      ? { meetingId_userId: { meetingId: target.meetingId, userId: entry.userId } }
      : { seriesId_occurrenceAt_userId: { seriesId: target.seriesId!, occurrenceAt: target.occurrenceAt!, userId: entry.userId } };
    const existing = await prisma.meetingAttendance.findUnique({ where, select: { id: true, recordedById: true, recordedBy: { select: { role: true } } } });
    if (existing && !recorderIsSenior && senior(existing.recordedById, existing.recordedBy.role)) {
      result.kept++;
      continue;
    }
    const data = { state: entry.state, note: entry.note?.trim() || null, recordedById: recorder.id, recordedAt: now };
    const row = existing
      ? await prisma.meetingAttendance.update({ where: { id: existing.id }, data, select: { id: true } })
      : await prisma.meetingAttendance.create({
          data: {
            ...data,
            orgId: target.orgId,
            meetingId: target.meetingId,
            seriesId: target.seriesId,
            occurrenceAt: target.occurrenceAt,
            relationId: target.relationId,
            meetingAt: target.meetingAt,
            userId: entry.userId,
          },
          select: { id: true },
        });
    result.saved++;
    if (entry.state === 'NO_SHOW') await nudgeNoShow(row.id, entry.userId, target, now);
  }
  return result;
}

/** The one neutral note to a no-show — claimed on the row, so editing the record never sends a second. */
async function nudgeNoShow(attendanceId: string, userId: string, target: AttendanceTarget, now: Date) {
  const claimed = await prisma.meetingAttendance.updateMany({ where: { id: attendanceId, noShowNotifiedAt: null }, data: { noShowNotifiedAt: now } });
  if (claimed.count !== 1) return;
  const link = notificationLink(userId === target.mentorId ? 'MENTOR' : 'MENTEE', 'relation', { relationId: target.relationId });
  await notifyIfAllowed(userId, 'meetingReminders', 'meeting.noShow', {}, link);
}

/**
 * A cancellation inside the late-cancel window is LATE_CANCEL for whoever
 * cancelled — when they are one of the pair. Called by the cancel path of
 * PATCH /api/meetings/[id]; never overwrites a record already there.
 */
export async function recordLateCancel(
  rows: { id: string; scheduledAt: Date | null; relation: { id: string; orgId: string | null; mentorId: string; menteeId: string } | null }[],
  cancellerId: string,
  now = new Date(),
): Promise<number> {
  if (rows.length === 0) return 0;
  const hours = parseInt(await resolveSettingRaw('lateCancelHours', { orgId: rows[0].relation?.orgId ?? null }), 10);
  const windowMs = (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 60 * 60 * 1000;
  let written = 0;
  for (const row of rows) {
    if (!row.relation || !row.scheduledAt) continue;
    if (cancellerId !== row.relation.mentorId && cancellerId !== row.relation.menteeId) continue;
    // Inside the window: from `windowMs` before the start onwards (a meeting
    // cancelled after it started is as late as it gets).
    if (row.scheduledAt.getTime() - now.getTime() > windowMs) continue;
    try {
      await prisma.meetingAttendance.create({
        data: {
          orgId: row.relation.orgId,
          meetingId: row.id,
          relationId: row.relation.id,
          meetingAt: row.scheduledAt,
          userId: cancellerId,
          state: 'LATE_CANCEL',
          recordedById: cancellerId,
          recordedAt: now,
        },
      });
      written++;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'P2002') throw error;
    }
  }
  return written;
}
