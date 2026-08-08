import { prisma } from '@/lib/prisma';

// The little card behind a person's name (#1166).
//
// The rule for who may see one is deliberately narrow and easy to state: **you
// can look up anyone whose name the app already shows you**. Concretely, that is
// a mentorship counterpart, someone on a project with you, or someone in a
// conversation with you — plus everyone, for an admin. Anything else is denied,
// so a role added later (COMPANY, SOURCE, whatever comes next) gets nothing
// until it is named here rather than inheriting a view it was never granted.

export interface CardViewer {
  id: string;
  role: string;
}

/** Whether `viewer` is allowed to see a summary card for `personId`. */
export async function canViewPersonCard(viewer: CardViewer, personId: string): Promise<boolean> {
  if (viewer.role === 'ADMIN') return true;
  // Your own card is always yours.
  if (viewer.id === personId) return true;
  if (viewer.role !== 'MENTOR' && viewer.role !== 'MENTEE') return false;

  // A mentorship either way round — the relation is what puts the two names on
  // each other's screens in the first place.
  const relation = await prisma.mentorshipRelation.findFirst({
    where: {
      OR: [
        { mentorId: viewer.id, menteeId: personId },
        { mentorId: personId, menteeId: viewer.id },
      ],
    },
    select: { id: true },
  });
  if (relation) return true;

  // A project they both work on (either as members or through a relation
  // attached to the project) — the group chat roster already names everyone.
  const sharedProject = await prisma.project.findFirst({
    where: {
      AND: [
        { OR: [{ members: { some: { userId: viewer.id } } }, { relations: { some: { menteeId: viewer.id } } }] },
        { OR: [{ members: { some: { userId: personId } } }, { relations: { some: { menteeId: personId } } }] },
      ],
    },
    select: { id: true },
  });
  if (sharedProject) return true;

  // A conversation they are both in (covers DMs started outside a mentorship).
  const sharedConversation = await prisma.conversation.findFirst({
    where: {
      AND: [
        { participants: { some: { userId: viewer.id } } },
        { participants: { some: { userId: personId } } },
      ],
    },
    select: { id: true },
  });
  return !!sharedConversation;
}

export interface PersonCard {
  id: string;
  fullName: string;
  role: string;
  preferredLanguage: string | null;
  avatarUrl: string | null;
  university: string | null;
  department: string | null;
  targetPosition: string | null;
  /** Present only for a mentee with an active mentorship. */
  pipelineStatus: string | null;
  mentorName: string | null;
  companyName: string | null;
  /** Only for viewers who can actually email them — see loadPersonCard. */
  email: string | null;
}

/**
 * The summary a card shows. `email` is included only for an admin or the
 * person's own mentor: the card offers an "email them" action, and an address
 * that no one on screen is allowed to write to has no business being in the
 * payload.
 */
export async function loadPersonCard(viewer: CardViewer, personId: string): Promise<PersonCard | null> {
  const person = await prisma.user.findUnique({
    where: { id: personId },
    select: {
      id: true,
      fullName: true,
      role: true,
      email: true,
      preferredLanguage: true,
      avatarUrl: true,
      university: true,
      department: true,
      targetPosition: true,
      menteeRelations: {
        where: { status: 'ACTIVE' },
        orderBy: { startDate: 'desc' },
        take: 1,
        select: {
          pipelineStatus: true,
          mentorId: true,
          mentor: { select: { fullName: true } },
          company: { select: { name: true } },
        },
      },
    },
  });
  if (!person) return null;

  const active = person.menteeRelations[0] ?? null;
  const mayEmail = viewer.role === 'ADMIN' || (!!active && active.mentorId === viewer.id);

  return {
    id: person.id,
    fullName: person.fullName,
    role: person.role,
    preferredLanguage: person.preferredLanguage,
    avatarUrl: person.avatarUrl,
    university: person.university,
    department: person.department,
    targetPosition: person.targetPosition,
    pipelineStatus: active?.pipelineStatus ?? null,
    mentorName: active?.mentor?.fullName ?? null,
    companyName: active?.company?.name ?? null,
    email: mayEmail ? person.email : null,
  };
}
