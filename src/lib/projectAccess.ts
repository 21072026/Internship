import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';

interface SessionUser {
  id: string;
  role: string;
  companyId?: string | null;
}

type ProjectOwner = {
  ownerType: 'ADMIN' | 'MENTOR' | 'MENTEE' | 'COMPANY';
  ownerUserId: string | null;
  ownerCompanyId: string | null;
};

// Who can see a project: admins (all), the owning mentor/admin, the owning
// company's users, or anyone if it's public.
export function canViewProject(user: SessionUser, p: ProjectOwner & { isPublic?: boolean }) {
  if (user.role === 'ADMIN') return true;
  if (p.isPublic) return true;
  if (p.ownerUserId && p.ownerUserId === user.id) return true;
  if (p.ownerCompanyId && user.companyId && p.ownerCompanyId === user.companyId) return true;
  return false;
}

// Who can edit/delete/transfer: admins, or the owning mentor/admin user.
// Companies are read-only.
export function canManageProject(user: SessionUser, p: ProjectOwner) {
  if (user.role === 'ADMIN') return true;
  if (p.ownerType !== 'COMPANY' && p.ownerUserId === user.id) return true;
  return false;
}

// Owner check against the members table (#619): admins and OWNER members.
// The legacy ownerUserId is honoured too (backfill safety net).
export async function isProjectOwner(user: SessionUser, projectId: string) {
  if (user.role === 'ADMIN') return true;
  const [member, legacy] = await Promise.all([
    prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
      select: { role: true },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { ownerUserId: true } }),
  ]);
  return member?.role === 'OWNER' || legacy?.ownerUserId === user.id;
}

// A MENTOR member (any role) may edit the collaborative fields; owners edit
// everything. Used by the PUT route to split the field set.
export async function isProjectMember(user: SessionUser, projectId: string) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { role: true },
  });
  return !!member;
}

// Validate + normalise an owner triplet so exactly one target is set and it
// matches ownerType, and the referenced entity exists IN THE CALLER'S TENANT
// (#2622 — by id alone, another tenant's user or company could own a project,
// and its name came back in the response). Returns null if invalid.
export async function resolveOwner(
  session: Session,
  input: {
    ownerType?: string;
    ownerUserId?: string | null;
    ownerCompanyId?: string | null;
  },
): Promise<ProjectOwner | null> {
  const tenant = await tenantWhere(session);
  const t = input.ownerType;
  if (t === 'ADMIN' || t === 'MENTOR' || t === 'MENTEE') {
    if (!input.ownerUserId) return null;
    const u = await prisma.user.findFirst({ where: withinTenant({ id: input.ownerUserId }, tenant), select: { role: true } });
    if (!u) return null;
    if (t === 'ADMIN' && u.role !== 'ADMIN') return null;
    if (t === 'MENTOR' && u.role !== 'MENTOR') return null;
    if (t === 'MENTEE' && u.role !== 'MENTEE') return null;
    return { ownerType: t, ownerUserId: input.ownerUserId, ownerCompanyId: null };
  }
  if (t === 'COMPANY') {
    if (!input.ownerCompanyId) return null;
    const c = await prisma.company.findFirst({ where: withinTenant({ id: input.ownerCompanyId }, tenant), select: { id: true } });
    if (!c) return null;
    return { ownerType: 'COMPANY', ownerUserId: null, ownerCompanyId: input.ownerCompanyId };
  }
  return null;
}

// Is project `id` in the caller's tenant? (#2622) Every rule above answers true
// for any ADMIN, and with MT_ENFORCE_ISOLATION off the org middleware scopes
// nothing — so each /api/projects/[id]/** handler asks this first and answers
// false with the 404 a missing project gets: another tenant's project is not
// "forbidden", it does not exist here. One query, the #2542 filter.
//
// Every other route that takes a project id asks it too (#2627): meetings and
// meeting series, contributor terms, note conversion and the project group chat.
// Those reach it from helpers that hold only `session.user`, so the one field it
// reads is all it asks for; a signed-in caller without an org is the default
// org's, exactly as `tenantWhere()` reads a full session.
export async function projectInCallerTenant(
  session: Pick<Session, 'user'> | { user: { orgId?: string | null } },
  id: string,
): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: withinTenant({ id }, await tenantWhere(session as Session)),
    select: { id: true },
  });
  return !!project;
}
