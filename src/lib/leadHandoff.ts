// The server half of the board's rep strip: who is on the team, and the one
// hand-off write. The rule — what a hand-off means and the note it leaves — is
// src/lib/leadHandoffRule.ts; ownership moves only through transferMentorship().
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { runUnscoped } from '@/lib/tenantAmbient';
import { canWriteSalesRecord } from '@/lib/salesBook';
import { findLeadOwner, LEAD_OWNER_ROLES } from '@/lib/leadOwner';
import { transferMentorship } from '@/lib/mentorTransfer';
import { nextActionPatch, parseNextActionDate } from '@/lib/nextActionRule';
import { followUpEventWrite } from '@/lib/followUpEvents';
import { notify, notifyIfAllowed } from '@/lib/notify';
import { sendLeadHandedOffEmail } from '@/services/emailService';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale } from '@/i18n/config';
import { composeHandoffNote, SALES_HANDOFF_REASON, todayIso, type HandoffAction } from '@/lib/leadHandoffRule';

export interface SalesTeamMember {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  self: boolean;
  /** Their ACTIVE records — the team page's "open" (#3875). */
  open: number;
  /**
   * Their overdue follow-ups (a due day before today, UTC), or null when the
   * viewer may not see per-person overdue counts — the team page's rule,
   * `canSeeRepOverdue` (admins and the dispatcher only).
   */
  overdue: number | null;
}

/** Bounded: the strip is a row of faces, not a directory. */
export const SALES_TEAM_LIMIT = 50;

/** Midnight UTC of `now`'s day — a follow-up due before it is overdue (isNextActionOverdue). */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Every active ADMIN/MENTOR of the org — exactly who `findLeadOwner` accepts as
 * an owner — with the load line under their name (#3875): the same counts the
 * team page shows, as COUNTs only, nothing about a record.
 */
export async function listSalesTeam(
  orgId: string,
  selfId: string,
  opts: { withOverdue: boolean; now?: Date } = { withOverdue: false },
): Promise<SalesTeamMember[]> {
  const rows = await runUnscoped(() =>
    prisma.user.findMany({
      where: { orgId, isActive: true, role: { in: [...LEAD_OWNER_ROLES] } },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: SALES_TEAM_LIMIT,
      select: { id: true, fullName: true, avatarUrl: true },
    }),
  );
  const ids = rows.map((r) => r.id);
  const [open, overdue] = await Promise.all([
    ids.length
      ? prisma.mentorshipRelation.groupBy({ by: ['mentorId'], where: { orgId, status: 'ACTIVE', mentorId: { in: ids } }, _count: { _all: true } })
      : Promise.resolve([]),
    opts.withOverdue && ids.length
      ? prisma.mentorshipRelation.groupBy({
          by: ['mentorId'],
          where: { orgId, status: 'ACTIVE', mentorId: { in: ids }, nextActionAt: { lt: startOfUtcDay(opts.now ?? new Date()) } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);
  const openBy = new Map(open.map((g) => [g.mentorId, g._count._all]));
  const overdueBy = new Map(overdue.map((g) => [g.mentorId, g._count._all]));
  return rows.map((r) => ({
    ...r,
    self: r.id === selfId,
    open: openBy.get(r.id) ?? 0,
    overdue: opts.withOverdue ? (overdueBy.get(r.id) ?? 0) : null,
  }));
}

export type HandoffOutcome =
  | { ok: true; relationId: string; mode: 'corrected' | 'transferred'; toName: string }
  | { ok: false; status: number; code: string };

/**
 * Who may hand this record off — the ONE answer, read by the hand-off below and
 * by the lead page's button (#3657), so the page never offers what the route
 * refuses. The owner hands off their own record; anyone else needs the admin
 * write on it, or is the org's sales dispatcher (#3656). Both of those answer
 * no under impersonation's write rules (dispatcherCovers), which is exactly
 * where the page could otherwise show a button that would 404.
 */
export async function actorMayHandOff(
  session: Session,
  relation: { orgId: string | null; mentorId: string; cohortId?: string | null; companyId?: string | null },
): Promise<boolean> {
  // The sales surface's write rule (src/lib/salesBookRule.ts) — one rule for
  // every write on a sales record, the hand-off included.
  return canWriteSalesRecord(session, relation);
}


export interface HandoffCurrent {
  ownerId: string;
  ownerName: string;
  nextActionAt: string | null;
  nextActionNote: string | null;
}

/**
 * What the hand-off dialog shows before anything moves (#3873): who has the
 * record now and the follow-up it carries, so a lead already with someone is
 * not handed on blind, and "keep the current follow-up" knows what it keeps.
 * The same gate as the write — whoever may not hand it off reads a 404.
 */
export async function handoffCurrent(session: Session, orgId: string, relationId: string): Promise<HandoffCurrent | null> {
  const relation = await prisma.mentorshipRelation.findFirst({
    where: { id: relationId, orgId },
    select: {
      orgId: true,
      mentorId: true,
      cohortId: true,
      companyId: true,
      nextActionAt: true,
      nextActionNote: true,
      mentor: { select: { fullName: true } },
    },
  });
  if (!relation || !(await actorMayHandOff(session, relation))) return null;
  return {
    ownerId: relation.mentorId,
    ownerName: relation.mentor.fullName,
    nextActionAt: relation.nextActionAt ? relation.nextActionAt.toISOString() : null,
    nextActionNote: relation.nextActionNote,
  };
}

export async function handOffLead(opts: {
  session: Session;
  orgId: string;
  relationId: string;
  toUserId: string;
  action: HandoffAction;
  note?: string | null;
  dueOn?: string | null;
  /**
   * Hand the record over with the follow-up it already has (#3873) instead of
   * a new step: the day and the note travel to the new owner unchanged, and
   * `action`/`note`/`dueOn` are ignored. Refused when there is none to keep.
   */
  keepFollowUp?: boolean;
  request?: Request;
}): Promise<HandoffOutcome> {
  const { session, orgId, relationId, toUserId, action, request } = opts;
  const actorId = session.user.id;

  const relation = await prisma.mentorshipRelation.findFirst({
    where: { id: relationId, orgId },
    select: {
      id: true,
      orgId: true,
      mentorId: true,
      menteeId: true,
      companyId: true,
      status: true,
      nextActionAt: true,
      nextActionNote: true,
      mentee: { select: { fullName: true } },
    },
  });
  if (!relation) return { ok: false, status: 404, code: 'missing' };
  // Not yours = 404, never a 403 that confirms the id.
  if (!(await actorMayHandOff(session, relation))) return { ok: false, status: 404, code: 'missing' };
  if (relation.mentorId === toUserId) return { ok: false, status: 400, code: 'same_owner' };

  const recipient = await findLeadOwner(orgId, toUserId);
  if (!recipient) return { ok: false, status: 400, code: 'invalid_recipient' };
  const recipientRow = await prisma.user.findUnique({
    where: { id: recipient.id },
    select: { fullName: true, preferredLanguage: true },
  });
  // The note is written in the language of the person who will read it.
  const locale = isLocale(recipientRow?.preferredLanguage) ? recipientRow!.preferredLanguage : defaultLocale;
  // The follow-up the recipient gets: the one the record has (kept), or the
  // step written in this dialog.
  let next: { at: Date | null; note: string | null };
  if (opts.keepFollowUp === true) {
    if (!relation.nextActionAt && !relation.nextActionNote) return { ok: false, status: 400, code: 'no_follow_up' };
    next = { at: relation.nextActionAt, note: relation.nextActionNote };
  } else {
    const labels = getDictionary(locale as Parameters<typeof getDictionary>[0]).leadHandoff.actions;
    const composed = composeHandoffNote(action, labels[action], opts.note);
    if (!composed.ok) return { ok: false, status: 400, code: composed.error };
    // No day picked means today: a hand-off is work to do now, not someday.
    const due = parseNextActionDate(opts.dueOn || todayIso());
    if (!due.ok || !due.value) return { ok: false, status: 400, code: 'invalid_date' };
    next = { at: due.value, note: composed.value };
  }
  // What the notices call the next step: the note, else the day.
  const stepText = next.note ?? (next.at ? next.at.toISOString().slice(0, 10) : '');

  const result = await transferMentorship({
    relationId: relation.id,
    toMentorId: recipient.id,
    reasonCode: SALES_HANDOFF_REASON,
    // The instruction rides into the transfer's audit row (ActivityLog), which
    // is the record of who handed what to whom.
    reasonNote: stepText,
    actorId,
    actorEmail: session.user.email ?? null,
    callerOrgId: orgId,
    request,
    // Both rep notices are sent below, in sales words with the instruction;
    // the lead is told nothing (leadHandoffRule.ts).
    batched: true,
    quietMentee: true,
  });
  if (result.status !== 200) {
    return { ok: false, status: result.status, code: String(result.body.code ?? 'transfer_failed') };
  }
  const newId = String(result.body.relationId);
  const mode = result.body.mode as 'corrected' | 'transferred';

  // The follow-up columns of the record the recipient now owns. Through the
  // shared patch, so a new day re-arms the due-day reminder.
  const current = await prisma.mentorshipRelation.findUnique({
    where: { id: newId },
    select: { nextActionAt: true, nextActionNote: true, updatedAt: true },
  });
  // The follow-up the lead had BEFORE the hand-off is the handed-off record's,
  // read above: a lead with history gets a new record (transferred), which
  // carries no follow-up (relationHistory.ts CARRIED_OVER_FIELDS), so reading it
  // from `current` showed every such hand-off as "no previous follow-up" (#3870).
  const before = { at: relation.nextActionAt, note: relation.nextActionNote };
  // ONE history line for the hand-off (#3819), carrying the follow-up it set —
  // not a "handed off" plus an "assigned" for the same click. In the same
  // transaction as the columns it describes.
  await prisma.$transaction([
    prisma.mentorshipRelation.update({
      where: { id: newId },
      data: nextActionPatch(current ?? { nextActionAt: null }, {
        nextActionAt: next.at,
        nextActionNote: next.note,
      }),
    }),
    followUpEventWrite({
      relationId: newId,
      facts: {
        kind: 'HANDED_OFF',
        fromAt: before.at,
        toAt: next.at,
        fromNote: before.note,
        toNote: next.note,
      },
      recordUpdatedAt: current?.updatedAt ?? new Date(0),
      actorId,
      owners: { from: relation.mentorId, to: recipient.id },
    }),
  ]);

  const menteeName = relation.mentee.fullName;
  if (recipient.id !== actorId) {
    await notifyIfAllowed(
      recipient.id,
      'mentorship',
      'lead.handedOff',
      { menteeName, from: session.user.name ?? '', action: stepText },
      `/sales/leads/${newId}`,
    );
    // …and by mail (#3871), as the admin's direct assignment already is. Keyed on
    // the record's state before this write, so a retried click mails once.
    await sendLeadHandedOffEmail({
      relationId: newId,
      leadName: menteeName,
      fromName: session.user.name ?? '',
      action: stepText,
      dueOn: next.at,
      recipientName: recipientRow?.fullName ?? '',
      orgId,
      userId: recipient.id,
      locale,
      dedupeKey: `lead-handoff:${newId}:${recipient.id}:${(current?.updatedAt ?? new Date(0)).getTime()}`,
    }).catch(() => {});
  }
  // An admin moved somebody else's record: its previous owner hears it left
  // their book. The MARKETING overlay says only that an admin took it (#3872):
  // never "by mistake", never who has it now.
  if (relation.mentorId !== actorId) {
    await notify(
      relation.mentorId,
      mode === 'corrected' ? 'mentorship.assignmentCorrected' : 'mentorship.reassignedAway',
      { menteeName },
      '/sales',
    );
  }

  return { ok: true, relationId: newId, mode, toName: recipientRow?.fullName ?? '' };
}
