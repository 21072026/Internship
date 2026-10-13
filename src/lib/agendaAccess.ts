import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { inCallerTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { publishRealtime } from '@/lib/realtimeBus';
import { readAgendaTranslations } from '@/lib/agendasRule';

// Who may read and write a session agenda (#1843), in one place.
//
// The agenda hangs off a MentorshipRelation, so the rule is the relation's:
// an admin of the tenant, the relation's mentor, or its mentee — exactly
// `relationIfAllowed` in src/app/api/goals/route.ts, copied here rather than
// imported because a route file may export only HTTP handlers. Another
// tenant's relation (and therefore agenda) answers like a missing one (#2542),
// so the id space stays opaque. Writes additionally honour the archived-
// relation lock (`menteeWriteClosed`, src/lib/menteeRelation.ts): a mentee
// cannot change the agendas of a mentorship that has ended.

export type AgendaViewer = { id: string; role: string };

/** The seats + status every rule here needs from the relation. */
export const agendaRelationSelect = {
  select: { id: true, mentorId: true, menteeId: true, orgId: true, status: true },
} as const;

export type AgendaRelation = { id: string; mentorId: string; menteeId: string; orgId: string | null; status: string };

export function viewerOf(session: Session): AgendaViewer {
  return { id: session.user.id, role: session.user.role };
}

/** Admin of the tenant, or one of the two seats. */
export function canReachRelation(rel: { mentorId: string; menteeId: string }, viewer: AgendaViewer): boolean {
  return viewer.role === 'ADMIN' || rel.mentorId === viewer.id || rel.menteeId === viewer.id;
}

/**
 * The relation when the caller may see its agendas; null when they may not,
 * and 'missing' when it does not exist for this caller (another tenant's).
 */
export async function relationForAgendas(session: Session, relationId: string) {
  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId }, ...agendaRelationSelect });
  if (!rel || !(await inCallerTenant(rel.orgId, resolveOrgId(session)))) return 'missing' as const;
  return canReachRelation(rel, viewerOf(session)) ? rel : null;
}

// What every agenda endpoint returns. The template halves are included so the
// client resolves a templated item's wording in the reader's language on every
// render (src/lib/agendasRule.ts resolveItemText) — the stored `text` is only
// the snapshot fallback.
export const agendaInclude = {
  template: { select: { id: true, title: true, translations: true, archivedAt: true } },
  items: {
    orderBy: { order: 'asc' as const },
    include: { templateItem: { select: { id: true, prompt: true, translations: true, guidance: true } } },
  },
} as const;

type AgendaRow = {
  id: string;
  relationId: string;
  meetingId: string | null;
  templateId: string | null;
  createdById: string | null;
  createdAt: Date;
  template: { id: string; title: string; translations: unknown; archivedAt: Date | null } | null;
  items: Array<{
    id: string;
    order: number;
    text: string;
    done: boolean;
    doneAt: Date | null;
    carriedFromItemId: string | null;
    templateItemId: string | null;
    templateItem: { id: string; prompt: string; translations: unknown; guidance: string | null } | null;
  }>;
};

/**
 * The client-facing shape. `guidance` is the mentor's facilitation note and is
 * withheld from the mentee — the prompt is the shared text, the note is not.
 */
export function serializeAgenda(agenda: AgendaRow, rel: { menteeId: string }, viewer: AgendaViewer) {
  const showGuidance = viewer.id !== rel.menteeId;
  return {
    id: agenda.id,
    relationId: agenda.relationId,
    meetingId: agenda.meetingId,
    templateId: agenda.templateId,
    createdById: agenda.createdById,
    createdAt: agenda.createdAt.toISOString(),
    template: agenda.template
      ? {
          id: agenda.template.id,
          title: agenda.template.title,
          translations: readAgendaTranslations(agenda.template.translations),
          archived: agenda.template.archivedAt !== null,
        }
      : null,
    items: agenda.items.map((item) => ({
      id: item.id,
      order: item.order,
      text: item.text,
      done: item.done,
      doneAt: item.doneAt ? item.doneAt.toISOString() : null,
      carried: item.carriedFromItemId !== null,
      templateItem: item.templateItem
        ? {
            id: item.templateItem.id,
            prompt: item.templateItem.prompt,
            translations: readAgendaTranslations(item.templateItem.translations),
            guidance: showGuidance ? item.templateItem.guidance : null,
          }
        : null,
    })),
  };
}

/** Tell both seats (and the actor's other tabs) that the agenda changed. */
export function announceAgendaChange(rel: { mentorId: string; menteeId: string }, relationId: string, actorId: string) {
  publishRealtime([rel.mentorId, rel.menteeId, actorId], { type: 'agenda', relationId, senderId: actorId });
}

/**
 * Load one agenda for a caller. 'missing' covers another tenant's agenda too;
 * null means "exists, in your tenant, but you are not in this mentorship".
 */
export async function agendaIfAllowed(session: Session, agendaId: string) {
  const agenda = await prisma.sessionAgenda.findUnique({
    where: { id: agendaId },
    include: { ...agendaInclude, relation: agendaRelationSelect },
  });
  if (!agenda || !(await inCallerTenant(agenda.relation.orgId, resolveOrgId(session)))) return 'missing' as const;
  if (!canReachRelation(agenda.relation, viewerOf(session))) return null;
  return agenda;
}
