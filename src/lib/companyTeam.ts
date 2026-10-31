// Team seats at a company (#1870, docs/company-team-seats.md) — the writes:
// a seat on registration, the team list, inviting a teammate within the seat
// limit, changing a role and removing a member. Server-only. The rules are pure
// in src/lib/companySeats.ts; who may call these is requireCompanySeat(
// 'team.manage') in the routes.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { IMPLICIT_SEAT_ROLE, isSeatRole, leavesNoOwner, seatLimitReached, type SeatRole } from '@/lib/companySeats';
import { deliverInvitation, invitationOrgWhere, logInvitationCreated, persistInvitation, type CreateInvitationInput } from '@/lib/inviteCreate';
import { findUserInWorld, worldOfOrg } from '@/lib/userWorld';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** The seat of a COMPANY login, written once. A second call (a retry) changes nothing. */
export async function ensureCompanyMembership(input: {
  orgId: string;
  companyId: string;
  userId: string;
  seatRole?: string | null;
  invitedById?: string | null;
}): Promise<void> {
  const seatRole: SeatRole = isSeatRole(input.seatRole) ? input.seatRole : IMPLICIT_SEAT_ROLE;
  try {
    await prisma.companyMembership.create({
      data: { orgId: input.orgId, companyId: input.companyId, userId: input.userId, seatRole, invitedById: input.invitedById ?? null },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

export interface TeamMember {
  userId: string;
  fullName: string | null;
  email: string;
  seatRole: SeatRole;
  isActive: boolean;
}

export interface PendingInvite {
  id: string;
  email: string | null;
  seatRole: SeatRole;
  expiresAt: string;
}

const liveInvitationWhere = (companyId: string): Prisma.InvitationTokenWhereInput => ({
  companyId,
  role: 'COMPANY',
  used: false,
  revokedAt: null,
  expiresAt: { gt: new Date() },
});

/** The company's active logins with their seat (the implicit OWNER for a login without a row), and its live invitations. */
export async function loadTeam(orgId: string, companyId: string): Promise<{ members: TeamMember[]; invites: PendingInvite[] }> {
  const [users, memberships, invites] = await Promise.all([
    prisma.user.findMany({
      where: { orgId, companyId, role: 'COMPANY', isActive: true },
      select: { id: true, fullName: true, email: true, isActive: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
    }),
    prisma.companyMembership.findMany({ where: { orgId, companyId }, select: { userId: true, seatRole: true } }),
    prisma.invitationToken.findMany({
      where: liveInvitationWhere(companyId),
      select: { id: true, email: true, companySeatRole: true, expiresAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const roleOf = new Map(memberships.map((m) => [m.userId, m.seatRole]));
  return {
    members: users.map((u) => {
      const stored = roleOf.get(u.id);
      return {
        userId: u.id,
        fullName: u.fullName,
        email: u.email,
        isActive: u.isActive,
        seatRole: stored === undefined ? IMPLICIT_SEAT_ROLE : isSeatRole(stored) ? stored : 'INTERVIEWER',
      };
    }),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      seatRole: isSeatRole(i.companySeatRole) ? i.companySeatRole : IMPLICIT_SEAT_ROLE,
      expiresAt: i.expiresAt.toISOString(),
    })),
  };
}

export type TeamRefusal =
  | { code: 'seat_limit_reached'; limit: number; used: number }
  | { code: 'email_taken' }
  | { code: 'invitation_pending' }
  | { code: 'last_owner' }
  | { code: 'not_found' }
  | { code: 'not_yourself' };

/** Invite a teammate by e-mail, bound to the company and the seat. The token is mailed, never returned. */
export async function inviteTeammate(input: {
  orgId: string;
  companyId: string;
  actor: { id: string; email?: string | null };
  email: string;
  seatRole: SeatRole;
  locale?: string | null;
  request?: Request;
}): Promise<{ ok: true; invitationId: string; emailSent: boolean } | { ok: false; refusal: TeamRefusal }> {
  const email = input.email.trim().toLowerCase();
  const company = await prisma.company.findFirst({ where: { id: input.companyId, orgId: input.orgId }, select: { quota: true } });
  if (!company) return { ok: false, refusal: { code: 'not_found' } };
  const [seated, pending] = await Promise.all([
    prisma.user.count({ where: { orgId: input.orgId, companyId: input.companyId, role: 'COMPANY', isActive: true } }),
    prisma.invitationToken.count({ where: liveInvitationWhere(input.companyId) }),
  ]);
  const used = seated + pending;
  // `Company.quota` is the seat limit (null = unlimited, today's behaviour).
  if (seatLimitReached({ quota: company.quota, used })) {
    return { ok: false, refusal: { code: 'seat_limit_reached', limit: company.quota as number, used } };
  }
  // Asked in the world of the company's org (docs/worlds.md), like every invite.
  if (await findUserInWorld(email, await worldOfOrg(input.orgId), { id: true })) return { ok: false, refusal: { code: 'email_taken' } };
  const live = await prisma.invitationToken.findFirst({
    where: { email, ...(await invitationOrgWhere(input.orgId)), used: false, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (live) return { ok: false, refusal: { code: 'invitation_pending' } };

  const invitation: CreateInvitationInput = {
    actor: input.actor,
    orgId: input.orgId,
    email,
    label: null,
    role: 'COMPANY',
    companyId: input.companyId,
    companySeatRole: input.seatRole,
    locale: input.locale ?? null,
    request: input.request,
  };
  const persisted = await persistInvitation(invitation);
  await logInvitationCreated(invitation, persisted.invitationId);
  const { emailSent } = await deliverInvitation(invitation, persisted);
  return { ok: true, invitationId: persisted.invitationId, emailSent };
}

async function ownerCount(orgId: string, companyId: string): Promise<number> {
  const team = await loadTeam(orgId, companyId);
  return team.members.filter((m) => m.seatRole === 'OWNER').length;
}

async function currentSeat(orgId: string, companyId: string, userId: string): Promise<SeatRole | null> {
  const team = await loadTeam(orgId, companyId);
  return team.members.find((m) => m.userId === userId)?.seatRole ?? null;
}

/** Change a teammate's seat. Demoting the last OWNER is refused. */
export async function changeSeatRole(input: { orgId: string; companyId: string; userId: string; seatRole: SeatRole }): Promise<{ ok: true } | { ok: false; refusal: TeamRefusal }> {
  const seat = await currentSeat(input.orgId, input.companyId, input.userId);
  if (!seat) return { ok: false, refusal: { code: 'not_found' } };
  if (leavesNoOwner({ owners: await ownerCount(input.orgId, input.companyId), targetIsOwner: seat === 'OWNER', nextRole: input.seatRole })) {
    return { ok: false, refusal: { code: 'last_owner' } };
  }
  await prisma.companyMembership.upsert({
    where: { companyId_userId: { companyId: input.companyId, userId: input.userId } },
    create: { orgId: input.orgId, companyId: input.companyId, userId: input.userId, seatRole: input.seatRole },
    update: { seatRole: input.seatRole },
  });
  return { ok: true };
}

/**
 * Remove a teammate from the company. The login is detached from the company
 * and deactivated, and every session and remembered device of it revoked
 * (docs/remember-me.md: whatever sets sessionsValidFrom also revokes the
 * trusted devices). Removing the last OWNER, or oneself, is refused. The User
 * row itself stays — its history (applications moved, messages sent) is the
 * company's record.
 */
export async function removeTeammate(input: { orgId: string; companyId: string; userId: string; actorId: string }): Promise<{ ok: true } | { ok: false; refusal: TeamRefusal }> {
  if (input.userId === input.actorId) return { ok: false, refusal: { code: 'not_yourself' } };
  const seat = await currentSeat(input.orgId, input.companyId, input.userId);
  if (!seat) return { ok: false, refusal: { code: 'not_found' } };
  if (leavesNoOwner({ owners: await ownerCount(input.orgId, input.companyId), targetIsOwner: seat === 'OWNER', nextRole: null })) {
    return { ok: false, refusal: { code: 'last_owner' } };
  }
  await prisma.$transaction([
    prisma.companyMembership.deleteMany({ where: { companyId: input.companyId, userId: input.userId } }),
    prisma.user.updateMany({
      where: { id: input.userId, orgId: input.orgId, companyId: input.companyId, role: 'COMPANY' },
      data: { companyId: null, isActive: false, sessionsValidFrom: new Date() },
    }),
  ]);
  await revokeAllTrustedDevices(input.userId);
  return { ok: true };
}
