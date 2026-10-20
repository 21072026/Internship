// The read resources of /api/v1 (#1990): for each one, the ONE `select` and
// the ONE serializer that both its list (`/api/v1/<resource>`) and its single
// read (`/api/v1/<resource>/{id}`) use, so the two can never disagree about a
// field. The queries — and their `orgId` filters — stay in the route files,
// where scripts/check-api-key-routes.mjs can see them next to withApiKey().
//
// The editorial line (#1990): no resource carries an e-mail address, a phone
// number or an interaction note body. A note body is added ONLY for a key
// holding `interactions:read_notes` (see serializeInteraction).
//
// Tenant anchor per resource — explicit in every query, never left to
// MT_ENFORCE_ISOLATION:
//   relationships, companies, requisitions, interview requests → their own orgId
//   interactions, offers → their relationship's orgId (Offer.orgId is nullable
//     and Offer is not a tenant model; InteractionLog has no orgId)
//   meetings → their relationship's or project's orgId; a meeting with neither
//     (a group-conversation call) has no org anchor and is not exposed
import { Prisma } from '@prisma/client';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ── Relationships ────────────────────────────────────────────────────────────
export const relationshipSelect = {
  id: true,
  mentorId: true,
  menteeId: true,
  companyId: true,
  status: true,
  pipelineStatus: true,
  startDate: true,
  completedAt: true,
  updatedAt: true,
} satisfies Prisma.MentorshipRelationSelect;

export function serializeRelationship(r: Prisma.MentorshipRelationGetPayload<{ select: typeof relationshipSelect }>) {
  return {
    id: r.id,
    mentorId: r.mentorId,
    menteeId: r.menteeId,
    companyId: r.companyId,
    status: r.status,
    pipelineStatus: r.pipelineStatus,
    startDate: iso(r.startDate),
    completedAt: iso(r.completedAt),
    updatedAt: iso(r.updatedAt),
  };
}

// ── Interactions ─────────────────────────────────────────────────────────────
export function interactionSelect(withNotes: boolean) {
  return {
    id: true,
    relationId: true,
    type: true,
    date: true,
    meetingId: true,
    updatedAt: true,
    notes: withNotes,
  } satisfies Prisma.InteractionLogSelect;
}

export function serializeInteraction(
  i: { id: string; relationId: string; type: string; date: Date; meetingId: string | null; updatedAt: Date; notes?: string },
  withNotes: boolean,
) {
  return {
    id: i.id,
    relationId: i.relationId,
    type: i.type,
    date: iso(i.date),
    meetingId: i.meetingId,
    updatedAt: iso(i.updatedAt),
    ...(withNotes ? { notes: i.notes ?? '' } : {}),
  };
}

// ── Meetings ─────────────────────────────────────────────────────────────────
export function meetingOrgWhere(orgId: string): Prisma.MeetingWhereInput {
  return { OR: [{ relation: { orgId } }, { project: { orgId } }] };
}

export const meetingSelect = {
  id: true,
  title: true,
  scheduledAt: true,
  durationMinutes: true,
  status: true,
  relationId: true,
  projectId: true,
  createdById: true,
  endedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  relation: { select: { mentorId: true, menteeId: true } },
  _count: { select: { guests: true } },
} satisfies Prisma.MeetingSelect;

export function serializeMeeting(m: Prisma.MeetingGetPayload<{ select: typeof meetingSelect }>) {
  // Account ids only: the organiser and, for a relationship meeting, its pair.
  // External guests are people without an account — a count, never a name.
  const participantIds = Array.from(
    new Set([m.createdById, m.relation?.mentorId, m.relation?.menteeId].filter((v): v is string => !!v)),
  );
  return {
    id: m.id,
    title: m.title,
    scheduledAt: iso(m.scheduledAt),
    durationMinutes: m.durationMinutes,
    status: m.status,
    relationId: m.relationId,
    projectId: m.projectId,
    participantIds,
    guestCount: m._count.guests,
    endedAt: iso(m.endedAt),
    cancelledAt: iso(m.cancelledAt),
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
  };
}

// ── Companies ────────────────────────────────────────────────────────────────
export const companySelect = {
  id: true,
  name: true,
  country: true,
  industry: true,
  size: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { requisitions: { where: { status: 'OPEN' } } } },
} satisfies Prisma.CompanySelect;

export function serializeCompany(c: Prisma.CompanyGetPayload<{ select: typeof companySelect }>) {
  return {
    id: c.id,
    name: c.name,
    country: c.country,
    industry: c.industry,
    size: c.size,
    openRequisitionCount: c._count.requisitions,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

// ── Hiring: requisitions, offers, interview requests ────────────────────────
export const requisitionSelect = {
  id: true,
  companyId: true,
  title: true,
  status: true,
  city: true,
  openings: true,
  filled: true,
  requiredSkills: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RequisitionSelect;

export function serializeRequisition(r: Prisma.RequisitionGetPayload<{ select: typeof requisitionSelect }>) {
  return {
    id: r.id,
    companyId: r.companyId,
    title: r.title,
    status: r.status,
    city: r.city,
    openings: r.openings,
    filled: r.filled,
    requiredSkills: r.requiredSkills,
    closedAt: iso(r.closedAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

// No compensation: money on an offer is withheld from everyone but the
// programme's own staff (OFFER_COMPENSATION_FIELDS, #1851), and an API key is
// handed to another system.
export const offerSelect = {
  id: true,
  relationId: true,
  requisitionId: true,
  companyId: true,
  status: true,
  startDate: true,
  expiresAt: true,
  sentAt: true,
  decidedAt: true,
  declineReasonCode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OfferSelect;

export function serializeOffer(o: Prisma.OfferGetPayload<{ select: typeof offerSelect }>) {
  return {
    id: o.id,
    relationId: o.relationId,
    requisitionId: o.requisitionId,
    companyId: o.companyId,
    status: o.status,
    startDate: iso(o.startDate),
    expiresAt: iso(o.expiresAt),
    sentAt: iso(o.sentAt),
    decidedAt: iso(o.decidedAt),
    declineReasonCode: o.declineReasonCode,
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
  };
}

export const interviewRequestSelect = {
  id: true,
  requisitionId: true,
  menteeId: true,
  companyId: true,
  status: true,
  scheduledAt: true,
  meetingId: true,
  decidedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.InterviewRequestSelect;

export function serializeInterviewRequest(r: Prisma.InterviewRequestGetPayload<{ select: typeof interviewRequestSelect }>) {
  return {
    id: r.id,
    requisitionId: r.requisitionId,
    menteeId: r.menteeId,
    companyId: r.companyId,
    status: r.status,
    scheduledAt: iso(r.scheduledAt),
    meetingId: r.meetingId,
    decidedAt: iso(r.decidedAt),
    cancelledAt: iso(r.cancelledAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}
