// The server half of the board's rep strip: who is on the team, and the one
// hand-off write. The rule — what a hand-off means and the note it leaves — is
// src/lib/leadHandoffRule.ts; ownership moves only through transferMentorship().
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { runUnscoped } from '@/lib/tenantAmbient';
import { actorFromSession, can } from '@/lib/authz';
import { relationSubject } from '@/lib/authzRule';
import { findLeadOwner, LEAD_OWNER_ROLES } from '@/lib/leadOwner';
import { transferMentorship } from '@/lib/mentorTransfer';
import { nextActionPatch, parseNextActionDate } from '@/lib/nextActionRule';
import { notify, notifyIfAllowed } from '@/lib/notify';
import { getDictionary } from '@/i18n/dictionaries';
import { defaultLocale, isLocale } from '@/i18n/config';
import { composeHandoffNote, SALES_HANDOFF_REASON, todayIso, type HandoffAction } from '@/lib/leadHandoffRule';

export interface SalesTeamMember {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  self: boolean;
}

/** Bounded: the strip is a row of faces, not a directory. */
export const SALES_TEAM_LIMIT = 50;

/** Every active ADMIN/MENTOR of the org — exactly who `findLeadOwner` accepts as an owner. */
export async function listSalesTeam(orgId: string, selfId: string): Promise<SalesTeamMember[]> {
  const rows = await runUnscoped(() =>
    prisma.user.findMany({
      where: { orgId, isActive: true, role: { in: [...LEAD_OWNER_ROLES] } },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: SALES_TEAM_LIMIT,
      select: { id: true, fullName: true, avatarUrl: true },
    }),
  );
  return rows.map((r) => ({ ...r, self: r.id === selfId }));
}

export type HandoffOutcome =
  | { ok: true; relationId: string; mode: 'corrected' | 'transferred'; toName: string }
  | { ok: false; status: number; code: string };

export async function handOffLead(opts: {
  session: Session;
  orgId: string;
  relationId: string;
  toUserId: string;
  action: HandoffAction;
  note?: string | null;
  dueOn?: string | null;
  request?: Request;
}): Promise<HandoffOutcome> {
  const { session, orgId, relationId, toUserId, action, request } = opts;
  const actorId = session.user.id;

  const relation = await prisma.mentorshipRelation.findFirst({
    where: { id: relationId, orgId },
    select: { id: true, orgId: true, mentorId: true, menteeId: true, companyId: true, status: true, mentee: { select: { fullName: true } } },
  });
  if (!relation) return { ok: false, status: 404, code: 'missing' };
  // The owner hands off their own record; anyone else needs the admin write on
  // it. Not yours = 404, never a 403 that confirms the id.
  if (relation.mentorId !== actorId) {
    const actor = await actorFromSession(session);
    if (!actor || !(await can(actor, 'relation.write', relationSubject(relation), session))) {
      return { ok: false, status: 404, code: 'missing' };
    }
  }
  if (relation.mentorId === toUserId) return { ok: false, status: 400, code: 'same_owner' };

  const recipient = await findLeadOwner(orgId, toUserId);
  if (!recipient) return { ok: false, status: 400, code: 'invalid_recipient' };
  const recipientRow = await prisma.user.findUnique({
    where: { id: recipient.id },
    select: { fullName: true, preferredLanguage: true },
  });
  // The note is written in the language of the person who will read it.
  const locale = isLocale(recipientRow?.preferredLanguage) ? recipientRow!.preferredLanguage : defaultLocale;
  const labels = getDictionary(locale as Parameters<typeof getDictionary>[0]).leadHandoff.actions;
  const composed = composeHandoffNote(action, labels[action], opts.note);
  if (!composed.ok) return { ok: false, status: 400, code: composed.error };

  // No day picked means today: a hand-off is work to do now, not someday.
  const due = parseNextActionDate(opts.dueOn || todayIso());
  if (!due.ok || !due.value) return { ok: false, status: 400, code: 'invalid_date' };

  const result = await transferMentorship({
    relationId: relation.id,
    toMentorId: recipient.id,
    reasonCode: SALES_HANDOFF_REASON,
    // The instruction rides into the transfer's audit row (ActivityLog), which
    // is the record of who handed what to whom.
    reasonNote: composed.value,
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
  const current = await prisma.mentorshipRelation.findUnique({ where: { id: newId }, select: { nextActionAt: true } });
  await prisma.mentorshipRelation.update({
    where: { id: newId },
    data: nextActionPatch(current ?? { nextActionAt: null }, {
      nextActionAt: due.value,
      nextActionNote: composed.value,
    }),
  });

  const menteeName = relation.mentee.fullName;
  if (recipient.id !== actorId) {
    await notifyIfAllowed(
      recipient.id,
      'mentorship',
      'lead.handedOff',
      { menteeName, from: session.user.name ?? '', action: composed.value },
      `/sales/leads/${newId}`,
    );
  }
  // An admin moved somebody else's record: its previous owner hears it left
  // their book (the MARKETING overlay words it as a hand-over to another rep).
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
