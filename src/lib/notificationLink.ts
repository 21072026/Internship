import type { Role } from '@prisma/client';

// Any role may receive a notification, so this takes the whole enum — including
// the SaleVali marketing roles, which this product has no shell for (see ROOTS).
export type NotificationRole = Role;

export type LinkKind =
  | 'relation'
  | 'thread'
  | 'mentee'
  | 'support'
  | 'project'
  | 'dashboard';

type LinkIds = {
  relationId?: string;
  menteeId?: string;
  projectId?: string;
};

// Exhaustive on purpose: `Partial` here would mean a role added to the enum
// later lands on the '/' fallback silently, and this codebase's rule is the
// opposite — a new Role that nobody wired up must break the build, not degrade
// quietly (the same reason src/lib/authzScope.ts is fail-closed). The marketing
// roles get an explicit '/' because they have no shell in THIS product; when the
// marketing surface lands they point at its dashboard instead.
const ROOTS: Record<NotificationRole, string> = {
  ADMIN: '/admin',
  MENTOR: '/mentor',
  MENTEE: '/portal',
  COMPANY: '/company',
  SOURCE: '/source',
  MARKETING_ADMIN: '/',
  MARKETING_MANAGER: '/',
  MARKETER: '/',
};

function validId(value?: string): string | null {
  return value && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

export function notificationLink(role: NotificationRole, kind: LinkKind, ids: LinkIds): string {
  const root = ROOTS[role] ?? '/';
  const relationId = validId(ids.relationId);
  const menteeId = validId(ids.menteeId);
  const projectId = validId(ids.projectId);

  if (kind === 'dashboard') return root;
  if (kind === 'support') return '/messages/support';
  if (kind === 'project') return projectId ? `/projects/${projectId}` : root;
  if (kind === 'thread') return relationId ? `/messages/${relationId}` : root;

  if (kind === 'relation' || kind === 'mentee') {
    if (role === 'MENTOR') return relationId ? `/mentor/mentees/${relationId}` : root;
    if (role === 'ADMIN') return menteeId ? `/admin/candidates/${menteeId}` : root;
    if (role === 'MENTEE') return '/portal';
  }

  return root;
}
